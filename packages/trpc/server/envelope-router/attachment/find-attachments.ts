import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { findAttachmentsByEnvelopeId } from '@documenso/lib/server-only/envelope-attachment/find-attachments-by-envelope-id';
import { findAttachmentsByToken } from '@documenso/lib/server-only/envelope-attachment/find-attachments-by-token';
import { assertRevalleGatePassed } from '@documenso/lib/server-only/revalle/gate/assert-gate-passed'; // REVALLE:
import { prisma } from '@documenso/prisma'; // REVALLE:

import { maybeAuthenticatedProcedure } from '../../trpc';
import {
  findAttachmentsMeta,
  ZFindAttachmentsRequestSchema,
  ZFindAttachmentsResponseSchema,
} from './find-attachments.types';

export const findAttachmentsRoute = maybeAuthenticatedProcedure
  .meta(findAttachmentsMeta)
  .input(ZFindAttachmentsRequestSchema)
  .output(ZFindAttachmentsResponseSchema)
  .query(async ({ input, ctx }) => {
    const { envelopeId, token } = input;

    ctx.logger.info({
      input: { envelopeId },
    });

    if (token) {
      // REVALLE: o portão (termo + identidade) vale também nos anexos por token
      const gateRecipient = await prisma.recipient.findFirst({
        where: { token, envelopeId },
        select: { id: true, email: true, role: true, signingStatus: true },
      });

      if (gateRecipient) {
        await assertRevalleGatePassed(gateRecipient, ctx.metadata.requestMetadata);
      }

      const data = await findAttachmentsByToken({ envelopeId, token });

      return {
        data,
      };
    }

    const { teamId } = ctx;
    const userId = ctx.user?.id;

    if (!userId || !teamId) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'You must be authenticated to access this resource',
      });
    }

    const data = await findAttachmentsByEnvelopeId({ envelopeId, teamId, userId });

    return {
      data,
    };
  });
