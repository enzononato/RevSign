import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { assertRevalleGatePassed } from '@documenso/lib/server-only/revalle/gate/assert-gate-passed'; // REVALLE:
import { prisma } from '@documenso/prisma';
import { EnvelopeType } from '@prisma/client';

import { authenticatedProcedure } from '../trpc';
import { ZGetDocumentByTokenRequestSchema, ZGetDocumentByTokenResponseSchema } from './get-document-by-token.types';

export const getDocumentByTokenRoute = authenticatedProcedure
  .input(ZGetDocumentByTokenRequestSchema)
  .output(ZGetDocumentByTokenResponseSchema)
  .query(async ({ input, ctx }) => {
    const { token } = input;

    const envelope = await prisma.envelope.findFirst({
      where: {
        type: EnvelopeType.DOCUMENT,
        recipients: {
          some: {
            token,
            email: ctx.user.email,
          },
        },
      },
      include: {
        envelopeItems: {
          include: {
            documentData: true,
          },
        },
        // REVALLE: destinatário do token, para o portão
        recipients: {
          where: { token, email: ctx.user.email },
          select: { id: true, email: true, role: true, signingStatus: true },
        },
      },
    });

    const firstDocumentData = envelope?.envelopeItems[0].documentData;

    if (!envelope || !firstDocumentData) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Document not found',
      });
    }

    // REVALLE: o PDF por token só depois do portão (termo + identidade), como nas demais rotas por token.
    await assertRevalleGatePassed(envelope.recipients[0], ctx.metadata.requestMetadata);

    if (envelope.envelopeItems.length !== 1) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'This endpoint does not support multiple items',
      });
    }

    ctx.logger.info({
      documentId: envelope.id,
    });

    return {
      documentData: firstDocumentData,
    };
  });
