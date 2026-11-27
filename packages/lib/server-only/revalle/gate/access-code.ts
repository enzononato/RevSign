import { createHash } from 'node:crypto';
import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { DocumentAuth, type TRecipientAccessAuth } from '../../../types/document-auth';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { validateTwoFactorTokenFromEmail } from '../../2fa/email/validate-2fa-token-from-email';
import { verifyTwoFactorAuthenticationToken } from '../../2fa/verify-2fa-token';
import { createRateLimit } from '../../rate-limit/rate-limit';
import { assertRateLimit } from '../../rate-limit/rate-limit-middleware';
import { lockRevalleGate } from './lock-gate';
import { REVALLE_MAX_ATTEMPTS } from './types';

// Conclusões por link (token): conta por destinatário, não por IP (uma unidade inteira sai por um único IP).
const revalleCompleteRateLimit = createRateLimit({ action: 'revalle.complete', max: 20, window: '15m' });

// Mesma janela do upstream para o código por e-mail: 10 períodos de 30 s (5 minutos).
const CODE_WINDOW = 10;

// v.26: o código do app autenticador vale no período de 30 s atual e no anterior (tolera o relógio do celular atrasado).
const TOTP_WINDOW = 2;

/** Como a pessoa confirmou a conclusão: código por e-mail ou app autenticador da própria conta (v.26). */
export type RevalleAccessCodeMethod = 'EMAIL' | 'AUTHENTICATOR';

type AuthenticatorUser = { id: number; name: string | null; email: string };

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
  authenticator?: { user: AuthenticatorUser | null },
) => {
  const authenticatorUser = authenticator?.user ?? null;

  await prisma.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type,
      envelopeId: recipient.envelopeId,
      requestMetadata,
      // Pelo autenticador, o histórico guarda a conta que confirmou (data, hora e usuário).
      ...(authenticatorUser
        ? { user: { id: authenticatorUser.id, name: authenticatorUser.name, email: authenticatorUser.email } }
        : {}),
      data: {
        recipientId: recipient.id,
        recipientName: recipient.name,
        recipientEmail: recipient.email,
        // Tentativa pelo autenticador fica marcada mesmo sem dono (sem sessão ou outra conta), só sem usuário.
        ...(authenticator ? { revalleMethod: 'AUTHENTICATOR' as const } : {}),
      },
    }),
  });
};

/**
 * A conta da sessão só serve para o autenticador se é a dona do e-mail do destinatário (e-mail confirmado, conta ativa)
 * e tem o autenticador ligado. Sem sessão, ou com outra conta, nulo: vale só o código por e-mail.
 */
const findAuthenticatorOwner = async (userId: number | null | undefined, recipientEmail: string) => {
  if (!userId) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      disabled: true,
      twoFactorEnabled: true,
      twoFactorSecret: true,
    },
  });

  if (
    !user ||
    !user.emailVerified ||
    user.disabled ||
    !user.twoFactorEnabled ||
    !user.twoFactorSecret ||
    user.email.trim().toLowerCase() !== recipientEmail.trim().toLowerCase()
  ) {
    return null;
  }

  return user;
};

/**
 * Na conclusão, quem age (nem CC nem VIEWER) só passa com o código de 6 dígitos enviado ao próprio e-mail, ou (v.26)
 * com o código do app autenticador, só quando a sessão é a conta dona do e-mail do destinatário e tem o autenticador
 * ligado. Nenhum outro fator vale (conta, senha, autenticador de outra conta). Cada código errado ou vencido, de um ou
 * de outro, conta a mesma tentativa; no 5º o link é bloqueado (CODE_ATTEMPTS). O código certo zera o contador.
 * Devolve o método que confirmou.
 */
export const assertRevalleAccessCode = async ({
  recipient,
  accessAuthOptions,
  requestMetadata,
  userId,
}: {
  recipient: AccessCodeRecipient;
  accessAuthOptions?: TRecipientAccessAuth;
  requestMetadata?: RequestMetadata;
  /** Usuário da sessão do pedido (o dono do autenticador). */
  userId?: number | null;
}): Promise<RevalleAccessCodeMethod> => {
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

    // Contador esgotado sem bloqueio (requisição que reservou a 5ª tentativa caiu antes de bloquear): bloqueia agora
    // para o link aparecer na lista do admin. Idempotente (só age com lockedAt nulo).
    await lockRevalleGate({
      recipientId: recipient.id,
      reason: 'CODE_ATTEMPTS',
      requestMetadata: requestMetadata ?? {},
    });

    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: 'Este link foi bloqueado por segurança.',
    });
  }

  const isTwoFactor =
    accessAuthOptions.type === DocumentAuth.TWO_FACTOR_AUTH && typeof accessAuthOptions.token === 'string';
  const isAuthenticator = isTwoFactor && accessAuthOptions.method === 'authenticator';

  // Autenticador sem ser o dono do e-mail (sem sessão, outra conta, autenticador desligado): recusado como código errado.
  const authenticatorOwner = isAuthenticator ? await findAuthenticatorOwner(userId, recipient.email) : null;

  let isValid = false;

  if (isAuthenticator) {
    isValid =
      authenticatorOwner !== null &&
      (await verifyTwoFactorAuthenticationToken({
        user: authenticatorOwner,
        totpCode: accessAuthOptions.token,
        window: TOTP_WINDOW,
      }));
  } else if (isTwoFactor && accessAuthOptions.method === 'email') {
    isValid = await validateTwoFactorTokenFromEmail({
      envelopeId: recipient.envelopeId,
      email: recipient.email,
      code: accessAuthOptions.token,
      window: CODE_WINDOW,
    });
  }

  if (!isValid) {
    await audit(
      DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_FAILED,
      recipient,
      requestMetadata,
      isAuthenticator ? { user: authenticatorOwner } : undefined,
    );

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

  await audit(
    DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_VALIDATED,
    recipient,
    requestMetadata,
    authenticatorOwner ? { user: authenticatorOwner } : undefined,
  );

  return authenticatorOwner ? 'AUTHENTICATOR' : 'EMAIL';
};
