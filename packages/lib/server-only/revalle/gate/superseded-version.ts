import { prisma } from '@documenso/prisma';
import { DocumentStatus, RevalleFinanceStatus, RevalleInvoiceStatus } from '@prisma/client';

import { AppError } from '../../../errors/app-error';

export const SUPERSEDED_VERSION_MESSAGE =
  'Este documento foi substituído por uma nova versão (conta contábil alterada).';

export const REVALLE_DOCUMENT_SUPERSEDED_CODE = 'REVALLE_DOCUMENT_SUPERSEDED';

export const supersededVersionError = () =>
  new AppError(REVALLE_DOCUMENT_SUPERSEDED_CODE, {
    message: SUPERSEDED_VERSION_MESSAGE,
    userMessage: SUPERSEDED_VERSION_MESSAGE,
    statusCode: 409,
  });

/**
 * Versão de NF substituída pelo Financeiro (conta trocada) e ainda não concluída: ninguém age mais nela, nem com a
 * página aberta (assinar campo, pedir o código, concluir, recusar, passar pelo portão, abrir). Uma versão já concluída
 * continua concluída e visível como antes.
 */
export const isSupersededPendingVersion = async (
  where: { recipientId: number } | { envelopeId: string },
): Promise<boolean> => {
  // Pela chave primária (o portão roda em cada ação de quem assina): o envelope com a linha da NF.
  const select = {
    status: true,
    revalleInvoice: { select: { isInvoice: true, financeStatus: true } },
  } as const;

  const envelope =
    'envelopeId' in where
      ? await prisma.envelope.findUnique({ where: { id: where.envelopeId }, select })
      : (await prisma.recipient.findUnique({ where: { id: where.recipientId }, select: { envelope: { select } } }))
          ?.envelope;

  return (
    envelope?.status !== undefined &&
    envelope.status !== DocumentStatus.COMPLETED &&
    envelope.revalleInvoice?.isInvoice === RevalleInvoiceStatus.YES &&
    envelope.revalleInvoice.financeStatus === RevalleFinanceStatus.SUPERSEDED
  );
};
