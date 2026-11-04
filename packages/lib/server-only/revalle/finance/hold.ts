import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';
import { RevalleFinanceStatus, RevalleInvoiceStatus } from '@prisma/client';

import { jobs } from '../../../jobs/client';
import { logger } from '../../../utils/logger';

/**
 * Primeiro envio de uma NF com conta: aguardando a aprovação do Financeiro. Vale também sobre `LEGACY` (rascunho de
 * antes da Fase 6 nunca pula o Financeiro). `APPROVED` fica: é uma nova versão já aprovada, pela troca de conta ou com a
 * aprovação copiada pela correção do centro. `SUPERSEDED` fica: esta marca roda antes da transação do envio, e um envio
 * atrasado (leu o rascunho, outro envio saiu e a versão foi substituída) não pode trazer a versão de volta.
 */
export const markInvoiceAwaitingApproval = async (envelopeId: string) => {
  await prisma.revalleInvoiceClassification.updateMany({
    where: {
      envelopeId,
      isInvoice: RevalleInvoiceStatus.YES,
      OR: [
        { financeStatus: null },
        { financeStatus: { notIn: [RevalleFinanceStatus.APPROVED, RevalleFinanceStatus.SUPERSEDED] } },
      ],
    },
    data: { financeStatus: RevalleFinanceStatus.PENDING_APPROVAL },
  });
};

/**
 * Na transação do envio: a nova versão de uma troca de conta (`APPROVED`) com a reserva solta (o envio dela falhou) que
 * sai agora por quem tem o rascunho. A aprovação foi a escolha do Financeiro (mesmo ato, mesma hora): `approvedAt` =
 * `choiceAt`, para o certificado ter a data. Só grava junto com o envio: um envio que falha deixa a reserva solta.
 */
export const stampReleasedApproval = async (envelopeId: string, tx: Prisma.TransactionClient) => {
  // Os nomes congelados vêm da reserva (a troca); sem eles, os atuais, junto com a data.
  await tx.$executeRaw`
    UPDATE "RevalleInvoiceClassification" c
    SET "approvedAt" = c."choiceAt",
      "approvedAccountName" = COALESCE(
        c."approvedAccountName",
        (SELECT a.name FROM "RevalleAccountingAccount" a WHERE a.code = c."choiceCode")
      ),
      "approvedByName" = COALESCE(
        c."approvedByName",
        (SELECT NULLIF(btrim(u.name), '') FROM "User" u WHERE u.id = c."approvedById")
      )
    WHERE c."envelopeId" = ${envelopeId}
      AND c."financeStatus" = 'APPROVED'
      AND c."approvedAt" IS NULL
      AND c."choiceAt" IS NOT NULL`;
};

/**
 * Primeiro envio de uma nova versão, de uma troca de conta ou de uma correção do centro (pelo próprio pedido, pelo
 * "Enviar de novo" ou pelo remetente depois de corrigir o rascunho): o aviso sai agora, com o link de assinatura da nova
 * versão. Antes do envio não há convite nem link para dar. Falhar o aviso não desfaz o envio.
 */
export const notifyInvoiceAccountChangeOnSend = async (envelopeId: string) => {
  try {
    const row = await prisma.revalleInvoiceClassification.findUnique({
      where: { envelopeId },
      select: { isInvoice: true, previousEnvelopeId: true },
    });

    if (row?.isInvoice !== RevalleInvoiceStatus.YES || !row.previousEnvelopeId) {
      return;
    }

    await jobs.triggerJob({
      name: 'send.revalle.finance.account.changed.email',
      payload: { oldEnvelopeId: row.previousEnvelopeId, newEnvelopeId: envelopeId },
    });
  } catch (error) {
    logger.warn({
      msg: 'revalle finance: falha ao disparar o aviso da nova versão',
      envelopeId,
      error: String(error),
    });
  }
};
