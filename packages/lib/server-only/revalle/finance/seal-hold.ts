import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';
import {
  DocumentStatus,
  RecipientRole,
  RevalleFinanceStatus,
  RevalleInvoiceStatus,
  SigningStatus,
} from '@prisma/client';

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

/** NF retida: pendente, todos os que agem já assinaram, ninguém recusou e a aprovação do Financeiro ainda falta. */
const signedAwaitingApprovalWhere = {
  isInvoice: RevalleInvoiceStatus.YES,
  financeStatus: RevalleFinanceStatus.PENDING_APPROVAL,
  envelope: {
    status: DocumentStatus.PENDING,
    deletedAt: null,
    recipients: {
      none: {
        OR: [
          { signingStatus: SigningStatus.REJECTED },
          { role: { not: RecipientRole.CC }, signingStatus: { not: SigningStatus.SIGNED } },
        ],
      },
    },
  },
} satisfies Prisma.RevalleInvoiceClassificationWhereInput;

/**
 * Para quem assina: todos os que agem já concluíram e a NF está retida esperando a aprovação do Financeiro (a página de
 * conclusão diz isso em vez de "Processando documento", que pode durar dias).
 */
export const isWaitingForFinanceApproval = async (envelopeId: string): Promise<boolean> => {
  const row = await prisma.revalleInvoiceClassification.findFirst({
    where: { envelopeId, ...signedAwaitingApprovalWhere },
    select: { envelopeId: true },
  });

  return row !== null;
};

/** NFs assinadas por todos esperando a aprovação: o admin vê o número na tela Admin → Financeiro. */
export const countInvoicesAwaitingApproval = async () =>
  await prisma.revalleInvoiceClassification.count({ where: signedAwaitingApprovalWhere });

/** Quantas NFs retidas a varredura de selagem confere por vez (a varredura roda a cada 15 minutos). */
export const FINANCE_APPROVAL_RETRY_BATCH = 20;

/**
 * Varredura de selagem: NF retida cujo pedido de aprovação nunca saiu (a última assinatura chegou sem ninguém no
 * Financeiro, ou o disparo falhou) recebe o pedido agora, sem selar. Sem membros, nem consulta. As que falharam voltam
 * para o fim da fila (o job devolve a marca e muda `updatedAt`). Devolve quantos pedidos foram disparados.
 */
export const retryFinanceApprovalRequests = async (): Promise<number> => {
  if ((await listFinanceMemberEmails()).length === 0) {
    return 0;
  }

  const rows = await prisma.revalleInvoiceClassification.findMany({
    where: { ...signedAwaitingApprovalWhere, approvalRequestedAt: null },
    select: { envelopeId: true },
    orderBy: { updatedAt: 'asc' },
    take: FINANCE_APPROVAL_RETRY_BATCH,
  });

  for (const { envelopeId } of rows) {
    await jobs.triggerJob({ name: 'send.revalle.finance.approval.email', payload: { envelopeId } });
  }

  return rows.length;
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
 * retenção; a marca é reservada no job). Falhar o aviso (ou não ter ninguém no Financeiro) nunca vira selagem: a NF
 * continua retida e a varredura de selagem pede de novo (`retryFinanceApprovalRequests`).
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
