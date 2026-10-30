import { prisma } from '@documenso/prisma';
import type { Field, Prisma, Recipient } from '@prisma/client';
import { RevalleFinanceStatus, RevalleInvoiceStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { jobs } from '../../../jobs/client';
import { logger } from '../../../utils/logger';
import { getRecipientsWithMissingFields } from '../../../utils/recipients';
import { assertRecipientEmailsAllowed } from '../assert-recipient-domains';
import { listFinanceMemberEmails } from './members';

export const INVOICE_HELD_FOR_FINANCE_CODE = 'INVOICE_HELD_FOR_FINANCE';
export const INVOICE_HELD_FOR_FINANCE_MESSAGE =
  'Enviado para o Financeiro definir a conta. Os convites saem depois disso.';

/**
 * Resposta do envio retido ("Deixar para o Financeiro"). É um erro de propósito: o documento NÃO foi distribuído
 * (continua rascunho, sem convites), e quem chama `sendDocument` (tela, API v1/v2) não pode tratar o retorno como
 * enviado nem mostrar links de assinatura. 409: o documento está num estado (aguardando o Financeiro) que impede o
 * envio agora. A tela trata o código como sucesso ("Enviado para o Financeiro…").
 */
export const invoiceHeldForFinanceError = () =>
  new AppError(INVOICE_HELD_FOR_FINANCE_CODE, {
    message: INVOICE_HELD_FOR_FINANCE_MESSAGE,
    userMessage: INVOICE_HELD_FOR_FINANCE_MESSAGE,
    statusCode: 409,
  });

/**
 * O que o envio de verdade recusaria, conferido ANTES de reter: o Financeiro não pode definir a conta de um documento
 * que depois não sai (destinatário fora dos domínios, signatário sem campo de assinatura). Sem gravar nada, e antes da
 * injeção de formValues (que troca o PDF e só pode acontecer uma vez, no envio).
 */
export const assertHeldInvoiceSendable = ({
  recipients,
  fields,
}: {
  recipients: Pick<Recipient, 'id' | 'role' | 'email'>[];
  fields: Pick<Field, 'type' | 'recipientId'>[];
}) => {
  assertRecipientEmailsAllowed(
    recipients.map((recipient) => recipient.email),
    { rejectEmpty: true },
  );

  const missing = getRecipientsWithMissingFields(recipients, fields);

  if (missing.length > 0) {
    throw new AppError(AppErrorCode.MISSING_SIGNATURE_FIELD, {
      message: `The following recipients are missing required fields: ${missing.map((r) => r.email).join(', ')}.`,
    });
  }
};

/**
 * Retém o envio da NF com "Deixar para o Financeiro": `AWAITING_ACCOUNT` (inclusive sobre `LEGACY`, marcado pela
 * migração num rascunho de antes da Fase 6) e o aviso aos membros do Financeiro. Sem ninguém no Financeiro a retenção
 * acontece igual: fica o aviso no log e na tela Admin → Financeiro, e o e-mail sai no próximo envio retido.
 */
export const holdInvoiceForFinance = async (envelopeId: string) => {
  await prisma.revalleInvoiceClassification.updateMany({
    where: { envelopeId, isInvoice: RevalleInvoiceStatus.YES, choiceDefer: true },
    data: { financeStatus: RevalleFinanceStatus.AWAITING_ACCOUNT },
  });

  try {
    await requestFinanceAccount(envelopeId);
  } catch (error) {
    // A retenção já foi gravada: falhar o aviso não pode virar envio. O próximo envio retido tenta de novo.
    logger.warn({ msg: 'revalle finance: falha ao disparar o aviso ao Financeiro', envelopeId, error: String(error) });
  }
};

const requestFinanceAccount = async (envelopeId: string) => {
  const row = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { accountRequestedAt: true },
  });

  if (row?.accountRequestedAt) {
    return;
  }

  if ((await listFinanceMemberEmails()).length === 0) {
    logger.warn({ msg: 'revalle finance: NF retida sem ninguém no Financeiro para definir a conta', envelopeId });

    return;
  }

  // A marca é reservada no job (uma vez por retenção, inclusive com dois envios ao mesmo tempo).
  await jobs.triggerJob({ name: 'send.revalle.finance.awaiting.email', payload: { envelopeId } });
};

/**
 * Primeiro envio de uma NF com conta: aguardando a aprovação do Financeiro. Vale também sobre `LEGACY` (rascunho de
 * antes da Fase 6 nunca pula o Financeiro). `APPROVED` fica: é o envio feito pelo próprio Financeiro (`defineAccount`).
 */
export const markInvoiceAwaitingApproval = async (envelopeId: string) => {
  await prisma.revalleInvoiceClassification.updateMany({
    where: {
      envelopeId,
      isInvoice: RevalleInvoiceStatus.YES,
      OR: [{ financeStatus: null }, { financeStatus: { not: RevalleFinanceStatus.APPROVED } }],
    },
    data: { financeStatus: RevalleFinanceStatus.PENDING_APPROVAL },
  });
};

/**
 * Na transação do envio: `APPROVED` com a reserva solta (o envio do Financeiro falhou) que sai agora por quem tem o
 * rascunho. A aprovação foi a escolha do Financeiro (mesmo ato, mesma hora): `approvedAt` = `choiceAt`, para o
 * certificado ter a data. Só grava junto com o envio: um envio que falha deixa a reserva solta.
 */
export const stampReleasedApproval = async (envelopeId: string, tx: Prisma.TransactionClient) => {
  await tx.$executeRaw`
    UPDATE "RevalleInvoiceClassification"
    SET "approvedAt" = "choiceAt"
    WHERE "envelopeId" = ${envelopeId}
      AND "financeStatus" = 'APPROVED'
      AND "approvedAt" IS NULL
      AND "choiceAt" IS NOT NULL`;
};

/** NFs retidas (rascunho não excluído) esperando a conta: o admin vê o número na tela Admin → Financeiro. */
export const countInvoicesAwaitingAccount = async () =>
  await prisma.revalleInvoiceClassification.count({
    where: {
      isInvoice: RevalleInvoiceStatus.YES,
      financeStatus: RevalleFinanceStatus.AWAITING_ACCOUNT,
      envelope: { deletedAt: null },
    },
  });
