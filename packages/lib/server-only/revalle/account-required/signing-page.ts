import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType } from '@prisma/client';
import {
  buildRevalleAccountPath,
  signingPathOf,
  tokenOfSigningReturnTo,
} from '../../../revalle/account-required/return-to';
import { normalizeEmail } from '../../../revalle/email-domain';
import { isRecipientExpired } from '../../../utils/recipients';
import { isSupersededPendingVersion } from '../gate/superseded-version';
import { getRevalleAccountCheck, isRevalleAccountRequiredFor } from './account-required';

export type RevalleSigningAccountState =
  | { type: 'NONE' }
  | { type: 'REDIRECT'; to: string }
  | { type: 'MISMATCH'; recipientEmail: string; sessionEmail: string; accountPath: string };

/** Destinatário de documento pendente que ainda pode agir pelo link (fora disso a página segue como antes). */
const findActingRecipient = async (token: string) => {
  const recipient = await prisma.recipient.findFirst({
    where: {
      token,
      envelope: { type: EnvelopeType.DOCUMENT, status: DocumentStatus.PENDING, deletedAt: null },
    },
    select: { id: true, email: true, role: true, signingStatus: true, expiresAt: true },
  });

  if (!recipient || isRecipientExpired(recipient)) {
    return null;
  }

  // Versão de NF substituída: a página mostra o aviso a qualquer pessoa; nenhuma ação vale mais nela.
  if (await isSupersededPendingVersion({ recipientId: recipient.id })) {
    return null;
  }

  return recipient;
};

const hasAccountFor = async (email: string) =>
  (await prisma.user.count({ where: { email: { equals: normalizeEmail(email), mode: 'insensitive' } } })) > 0;

/**
 * Para o loader da página de assinatura: sem sessão, manda entrar (conta existe) ou criar a conta (não existe), com o
 * e-mail preenchido e a volta para este documento; com a sessão de outra conta, a página de troca de conta.
 */
export const getRevalleSigningAccountState = async ({
  token,
  sessionUser,
}: {
  token: string;
  sessionUser: { id: number; email: string } | null | undefined;
}): Promise<RevalleSigningAccountState> => {
  const recipient = await findActingRecipient(token);

  if (!recipient) {
    return { type: 'NONE' };
  }

  const check = await getRevalleAccountCheck(recipient, { userId: sessionUser?.id });

  if (check.status === 'NOT_REQUIRED' || check.status === 'OK') {
    return { type: 'NONE' };
  }

  const accountPath = buildRevalleAccountPath({
    hasAccount: await hasAccountFor(recipient.email),
    email: recipient.email,
    returnTo: signingPathOf(token),
  });

  if (check.status === 'WRONG_USER' && sessionUser) {
    return {
      type: 'MISMATCH',
      recipientEmail: normalizeEmail(recipient.email),
      sessionEmail: sessionUser.email,
      accountPath,
    };
  }

  return { type: 'REDIRECT', to: accountPath };
};

/**
 * Cadastro aberto pelo link de assinatura: o e-mail vem travado quando é o do destinatário do token, ele ainda precisa
 * da conta e ela não existe. O travamento é só da tela: o cadastro continua exigindo a confirmação do e-mail antes de
 * qualquer assinatura (a sessão só vale com o e-mail confirmado).
 */
export const getRevalleSignupLockedEmail = async ({
  email,
  returnTo,
}: {
  email: string | null | undefined;
  returnTo: string | null | undefined;
}): Promise<string | null> => {
  const token = tokenOfSigningReturnTo(returnTo);

  if (!token || !email) {
    return null;
  }

  const recipient = await findActingRecipient(token);

  if (
    !recipient ||
    normalizeEmail(recipient.email) !== normalizeEmail(email) ||
    !isRevalleAccountRequiredFor(recipient)
  ) {
    return null;
  }

  if (await hasAccountFor(recipient.email)) {
    return null;
  }

  return normalizeEmail(recipient.email);
};
