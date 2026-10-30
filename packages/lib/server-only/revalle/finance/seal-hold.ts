import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';
import { DocumentStatus, RevalleFinanceStatus, RevalleInvoiceStatus, SigningStatus } from '@prisma/client';

import { jobs } from '../../../jobs/client';
import { logger } from '../../../utils/logger';
import { listFinanceMemberEmails } from './members';

/**
 * A selagem da NF espera o Financeiro: só `PENDING_APPROVAL` retém (`APPROVED` e `LEGACY` selam; documento comum
 * nem tem linha). Documento recusado nunca é retido: a recusa sela na hora, como no upstream.
 */
export const shouldHoldSeal = async (envelopeId: string): Promise<boolean> => {
  const row = await prisma.revalleInvoiceClassification.findFirst({
    where: {
      envelopeId,
      isInvoice: RevalleInvoiceStatus.YES,
      financeStatus: RevalleFinanceStatus.PENDING_APPROVAL,
      envelope: { recipients: { none: { signingStatus: SigningStatus.REJECTED } } },
    },
    select: { envelopeId: true },
  });

  return row !== null;
};

/**
 * Versão substituída pelo Financeiro (conta trocada) e ainda não concluída: nunca é selada, nem depois (a nova versão é
 * que segue). Diferente da retenção: não há aprovação a pedir. Uma versão já concluída continua concluída, e a
 * reselagem dela pelo admin segue normal; recusada também sela (como na varredura).
 */
export const isSupersededUnsealed = async (envelopeId: string): Promise<boolean> => {
  const row = await prisma.revalleInvoiceClassification.findFirst({
    where: {
      envelopeId,
      isInvoice: RevalleInvoiceStatus.YES,
      financeStatus: RevalleFinanceStatus.SUPERSEDED,
      envelope: {
        status: { not: DocumentStatus.COMPLETED },
        recipients: { none: { signingStatus: SigningStatus.REJECTED } },
      },
    },
    select: { envelopeId: true },
  });

  return row !== null;
};

/**
 * Na transação final da selagem: trava a linha da NF (`FOR UPDATE`) e confere de novo se ela foi substituída. A troca
 * de conta grava `SUPERSEDED` nessa mesma linha, então as duas ficam em ordem: se a troca venceu, a selagem não conclui;
 * se a selagem venceu, a troca encontra a versão concluída (que continua concluída e visível).
 */
export const lockSupersededInvoiceForSealing = async (tx: Prisma.TransactionClient, envelopeId: string) => {
  const rows = await tx.$queryRaw<{ financeStatus: string | null }[]>`
    SELECT "financeStatus"::text AS "financeStatus"
    FROM "RevalleInvoiceClassification"
    WHERE "envelopeId" = ${envelopeId} AND "isInvoice" = 'YES'
    FOR UPDATE`;

  return rows[0]?.financeStatus === RevalleFinanceStatus.SUPERSEDED;
};

/**
 * O guard de cada ponto que dispara `internal.seal-document` (e do próprio job): `true` = não selar agora. Versão
 * substituída: bloqueada, sem aviso. Retenção: pede o e-mail "aguardando aprovação" aos membros do Financeiro (um por
 * retenção; a marca é reservada no job). Falhar o aviso nunca vira selagem: a NF continua retida e o próximo disparo
 * (ex.: a varredura) tenta de novo.
 */
export const holdSealForFinance = async (envelopeId: string): Promise<boolean> => {
  if (await isSupersededUnsealed(envelopeId)) {
    return true;
  }

  if (!(await shouldHoldSeal(envelopeId))) {
    return false;
  }

  try {
    await requestFinanceApproval(envelopeId);
  } catch (error) {
    logger.warn({ msg: 'revalle finance: falha ao pedir a aprovação ao Financeiro', envelopeId, error: String(error) });
  }

  return true;
};

const requestFinanceApproval = async (envelopeId: string) => {
  const row = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { approvalRequestedAt: true },
  });

  if (row?.approvalRequestedAt) {
    return;
  }

  if ((await listFinanceMemberEmails()).length === 0) {
    logger.warn({ msg: 'revalle finance: NF retida sem ninguém no Financeiro para aprovar', envelopeId });

    return;
  }

  await jobs.triggerJob({ name: 'send.revalle.finance.approval.email', payload: { envelopeId } });
};
