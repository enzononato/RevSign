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
  const row = await prisma.revalleInvoiceClassification.findFirst({
    where: {
      isInvoice: RevalleInvoiceStatus.YES,
      financeStatus: RevalleFinanceStatus.SUPERSEDED,
      ...('envelopeId' in where ? { envelopeId: where.envelopeId } : {}),
      envelope: {
        status: { not: DocumentStatus.COMPLETED },
        ...('recipientId' in where ? { recipients: { some: { id: where.recipientId } } } : {}),
      },
    },
    select: { envelopeId: true },
  });

  return row !== null;
};
