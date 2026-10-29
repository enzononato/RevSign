import { createHash } from 'node:crypto';
import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { DocumentAuth, type TRecipientAccessAuth } from '../../../types/document-auth';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { validateTwoFactorTokenFromEmail } from '../../2fa/email/validate-2fa-token-from-email';
import { createRateLimit } from '../../rate-limit/rate-limit';
import { assertRateLimit } from '../../rate-limit/rate-limit-middleware';
import { lockRevalleGate } from './lock-gate';
import { REVALLE_MAX_ATTEMPTS } from './types';

// Conclusões por link (token): conta por destinatário, não por IP (uma unidade inteira sai por um único IP).
const revalleCompleteRateLimit = createRateLimit({ action: 'revalle.complete', max: 20, window: '15m' });

// Mesma janela do upstream para o código por e-mail: 10 períodos de 30 s (5 minutos).
const CODE_WINDOW = 10;

type AccessCodeRecipient = {
  id: number;
  name: string;
  email: string;
  token: string;
  envelopeId: string;
};

// Reserva a tentativa antes de conferir o código: com requisições em paralelo, no máximo 5 códigos são avaliados.
const reserveCodeAttempt = async (recipientId: number): Promise<number | null> => {
  const rows = await prisma.$queryRaw<Array<{ codeFailedAttempts: number }>>`
    UPDATE "RevalleRecipientGate"
    SET "codeFailedAttempts" = "codeFailedAttempts" + 1, "updatedAt" = now()
    WHERE "recipientId" = ${recipientId} AND "lockedAt" IS NULL AND "codeFailedAttempts" < ${REVALLE_MAX_ATTEMPTS}
    RETURNING "codeFailedAttempts"`;

  return rows[0]?.codeFailedAttempts ?? null;
};

const audit = async (
  type:
    | typeof DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_FAILED
    | typeof DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_VALIDATED,
  recipient: AccessCodeRecipient,
  requestMetadata: RequestMetadata | undefined,
) => {
  await prisma.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type,
      envelopeId: recipient.envelopeId,
      requestMetadata,
      data: {
        recipientId: recipient.id,
        recipientName: recipient.name,
        recipientEmail: recipient.email,
      },
    }),
  });
};

/**
 * Na conclusão, quem age (nem CC nem VIEWER) só passa com o código de 6 dígitos enviado ao próprio e-mail.
 * Nenhum outro fator vale (autenticador da conta logada, conta, senha). Cada código errado ou vencido conta;
 * no 5º o link é bloqueado (CODE_ATTEMPTS). O código certo zera o contador.
 */
export const assertRevalleAccessCode = async ({
  recipient,
  accessAuthOptions,
  requestMetadata,
}: {
  recipient: AccessCodeRecipient;
  accessAuthOptions?: TRecipientAccessAuth;
  requestMetadata?: RequestMetadata;
}): Promise<void> => {
  const identifier = `revalle-complete:${createHash('sha256').update(recipient.token).digest('hex').slice(0, 32)}`;

  assertRateLimit(await revalleCompleteRateLimit.check({ ip: requestMetadata?.ipAddress ?? 'unknown', identifier }));

  if (!accessAuthOptions) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: 'Access authentication required',
    });
  }

  if (!recipient.email.trim()) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `Recipient ${recipient.id} requires an email because they have auth requirements.`,
    });
  }

  const attempt = await reserveCodeAttempt(recipient.id);

  if (attempt === null) {
    await audit(DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_FAILED, recipient, requestMetadata);

    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: 'Este link foi bloqueado por segurança.',
    });
  }

  const isValid =
    accessAuthOptions.type === DocumentAuth.TWO_FACTOR_AUTH &&
    accessAuthOptions.method === 'email' &&
    typeof accessAuthOptions.token === 'string' &&
    (await validateTwoFactorTokenFromEmail({
      envelopeId: recipient.envelopeId,
      email: recipient.email,
      code: accessAuthOptions.token,
      window: CODE_WINDOW,
    }));

  if (!isValid) {
    await audit(DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_FAILED, recipient, requestMetadata);

    if (attempt >= REVALLE_MAX_ATTEMPTS) {
      await lockRevalleGate({
        recipientId: recipient.id,
        reason: 'CODE_ATTEMPTS',
        requestMetadata: requestMetadata ?? {},
      });
    }

    throw new AppError(AppErrorCode.TWO_FACTOR_AUTH_FAILED, {
      message: 'Invalid 2FA authentication',
    });
  }

  await prisma.revalleRecipientGate.updateMany({
    where: { recipientId: recipient.id },
    data: { codeFailedAttempts: 0 },
  });

  await audit(DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_VALIDATED, recipient, requestMetadata);
};
