import { TWO_FACTOR_EMAIL_EXPIRATION_MINUTES } from '@documenso/lib/server-only/2fa/email/constants';
import { send2FATokenEmail } from '@documenso/lib/server-only/2fa/email/send-2fa-token-email';
import { assertRateLimit } from '@documenso/lib/server-only/rate-limit/rate-limit-middleware';
import { request2FAEmailRateLimit } from '@documenso/lib/server-only/rate-limit/rate-limits';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, RecipientRole, SigningStatus } from '@prisma/client'; // REVALLE: DocumentStatus, RecipientRole, SigningStatus
import { TRPCError } from '@trpc/server';
import { DateTime } from 'luxon';

import { procedure } from '../trpc';
import {
  ZAccessAuthRequest2FAEmailRequestSchema,
  ZAccessAuthRequest2FAEmailResponseSchema,
} from './access-auth-request-2fa-email.types';

export const accessAuthRequest2FAEmailRoute = procedure
  .input(ZAccessAuthRequest2FAEmailRequestSchema)
  .output(ZAccessAuthRequest2FAEmailResponseSchema)
  .mutation(async ({ input, ctx }) => {
    try {
      const { token } = input;

      const rateLimitResult = await request2FAEmailRateLimit.check({
        ip: ctx.metadata.requestMetadata.ipAddress ?? 'unknown',
        identifier: token,
      });

      assertRateLimit(rateLimitResult);

      const user = ctx.user;

      // Get document and recipient by token
      // REVALLE: código só para quem ainda não concluiu (NOT_SIGNED, nunca CC) em documento pendente; senão NOT_FOUND.
      // VIEWER continua podendo pedir: a tela do upstream pede o código para "marcar como visto" (o documento só sela depois).
      const revalleRecipientWhere = {
        token,
        role: { not: RecipientRole.CC },
        signingStatus: SigningStatus.NOT_SIGNED,
      };

      const envelope = await prisma.envelope.findFirst({
        where: {
          type: EnvelopeType.DOCUMENT,
          status: DocumentStatus.PENDING, // REVALLE:
          recipients: {
            some: revalleRecipientWhere, // REVALLE:
          },
        },
        include: {
          recipients: {
            where: revalleRecipientWhere, // REVALLE:
          },
        },
      });

      if (!envelope) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Document not found',
        });
      }

      const [recipient] = envelope.recipients;

      // REVALLE: o código por e-mail vale para qualquer documento (a conclusão o exige sempre), então não há recusa aqui.

      // if (user && recipient.email !== user.email) {
      //   throw new TRPCError({
      //     code: 'UNAUTHORIZED',
      //     message: 'User does not match recipient',
      //   });
      // }

      const expiresAt = DateTime.now().plus({ minutes: TWO_FACTOR_EMAIL_EXPIRATION_MINUTES });

      await send2FATokenEmail({
        token,
        envelopeId: envelope.id,
        requestMetadata: ctx.metadata.requestMetadata, // REVALLE:
      });

      return {
        success: true,
        expiresAt: expiresAt.toJSDate(),
      };
    } catch (error) {
      console.error('Error sending access auth 2FA email:', error);

      if (error instanceof TRPCError) {
        throw error;
      }

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to send 2FA email',
      });
    }
  });
