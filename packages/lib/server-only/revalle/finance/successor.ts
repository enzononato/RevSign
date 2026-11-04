import { prisma } from '@documenso/prisma';
import type { RevalleInvoiceClassification } from '@prisma/client';
import { DocumentStatus, RevalleFinanceStatus } from '@prisma/client';

/**
 * Uma troca de conta ou correção do centro que morreu no meio (queda do processo entre marcar a versão antiga e ligar a
 * nova) deixa a antiga `SUPERSEDED` sem sucessora. Passado esse prazo, outro pedido a retoma, de qualquer um dos tipos;
 * antes dele, 409 "em andamento".
 */
export const FINANCE_CHANGE_LEASE_MS = 5 * 60 * 1000;

/**
 * Marca `SUPERSEDED` que outro pedido pode retomar: sem sucessora há mais que o prazo (troca que morreu no meio), ou com
 * uma sucessora que não existe mais (a nova versão foi apagada). Os cartões do Financeiro e da Contabilidade usam a mesma
 * regra para oferecer "Trocar conta" e "Corrigir centro de custo" de novo.
 */
export const isStaleChangeClaim = async (
  row: Pick<RevalleInvoiceClassification, 'financeStatus' | 'supersededAt' | 'supersededByEnvelopeId'>,
  now: Date,
) => {
  if (row.financeStatus !== RevalleFinanceStatus.SUPERSEDED || row.supersededAt === null) {
    return false;
  }

  if (row.supersededByEnvelopeId === null) {
    return now.getTime() - row.supersededAt.getTime() >= FINANCE_CHANGE_LEASE_MS;
  }

  const successor = await prisma.envelope.findUnique({
    where: { id: row.supersededByEnvelopeId },
    select: { id: true },
  });

  return successor === null;
};

/**
 * O que criou uma nova versão: o tipo gravado na marca da versão anterior. Numa correção do centro, `approvedAt` é a
 * aprovação copiada; só na troca de conta ele também é a reserva do envio (`define-and-send.ts`). `null`: sem anterior.
 */
export const findNewVersionKind = async (previousEnvelopeId: string | null) => {
  if (!previousEnvelopeId) {
    return null;
  }

  const previous = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId: previousEnvelopeId },
    select: { supersedeKind: true },
  });

  return previous?.supersedeKind ?? null;
};

/**
 * A nova versão para o link "Abrir a nova versão": só se ela existe e abre na página da NF (não foi excluída, salvo a
 * versão pendente que uma troca seguinte escondeu). Sem isso, o link levaria a um 404.
 */
export const findVisibleSuccessor = async (envelopeId: string | null) => {
  if (!envelopeId) {
    return null;
  }

  const envelope = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: {
      id: true,
      title: true,
      status: true,
      deletedAt: true,
      revalleInvoice: { select: { financeStatus: true } },
    },
  });

  if (!envelope) {
    return null;
  }

  const hiddenSuperseded =
    envelope.revalleInvoice?.financeStatus === RevalleFinanceStatus.SUPERSEDED &&
    envelope.status !== DocumentStatus.COMPLETED;

  return envelope.deletedAt && !hiddenSuperseded ? null : { id: envelope.id, title: envelope.title };
};
