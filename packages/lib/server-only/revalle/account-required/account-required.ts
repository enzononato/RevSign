import { prisma } from '@documenso/prisma';

import { getAllowedSignupDomains } from '../../../constants/auth';
import { AppError } from '../../../errors/app-error';
import {
  checkRevalleAccount,
  isRevalleAccountRequired,
  REVALLE_ACCOUNT_MISMATCH_CODE,
  REVALLE_ACCOUNT_REQUIRED_CODE,
  type RevalleAccountCheck,
  type RevalleAccountRecipient,
} from '../../../revalle/account-required/rule';
import { env } from '../../../utils/env';
import { isCollaboratorContractRecipient } from '../collaborator-contract/marker';

/**
 * Quem age com o token do destinatário: o usuário da sessão do pedido (null/undefined sem sessão). Todas as ações por
 * token passam por aqui junto com o portão (`assertRevalleGatePassed`); ver `revalle/account-required/rule.ts`.
 */
export type RevalleSigningActor = { userId: number | null | undefined };

/** Desligar só em emergência (`NEXT_PRIVATE_REVALLE_ACCOUNT_REQUIRED=disabled`): volta a assinatura só pelo link. */
export const isRevalleAccountRuleEnabled = () => env('NEXT_PRIVATE_REVALLE_ACCOUNT_REQUIRED') !== 'disabled';

export const isRevalleAccountRequiredFor = (recipient: RevalleAccountRecipient): boolean =>
  isRevalleAccountRuleEnabled() && isRevalleAccountRequired(recipient, getAllowedSignupDomains());

/** E-mail da conta da sessão, só se a conta existe, confirmou o e-mail e não está desativada. */
const sessionEmailOf = async (userId: number | null | undefined): Promise<string | null> => {
  if (!userId) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true, disabled: true },
  });

  return user?.emailVerified && !user.disabled ? user.email : null;
};

export const getRevalleAccountCheck = async (
  recipient: RevalleAccountRecipient,
  actor: RevalleSigningActor,
): Promise<RevalleAccountCheck> => {
  if (!isRevalleAccountRequiredFor(recipient)) {
    return { status: 'NOT_REQUIRED' };
  }

  // v.21: documento do contrato para colaboradores: sem conta (o portão pede CPF e data de nascimento sempre). Quem já
  // está logado com a própria conta entra normalmente. Sem o id do destinatário, a regra de sempre (conta exigida).
  if (recipient.id !== undefined && (await isCollaboratorContractRecipient(recipient.id))) {
    return { status: 'NOT_REQUIRED' };
  }

  return checkRevalleAccount({
    recipient,
    domains: getAllowedSignupDomains(),
    sessionEmail: await sessionEmailOf(actor.userId),
  });
};

export const REVALLE_ACCOUNT_REQUIRED_MESSAGE = 'Entre na sua conta do RevSign para assinar este documento.';
export const REVALLE_ACCOUNT_MISMATCH_MESSAGE =
  'Este documento é para outra conta do RevSign. Saia e entre com a conta do e-mail que recebeu o documento.';

export const revalleAccountRequiredError = () =>
  new AppError(REVALLE_ACCOUNT_REQUIRED_CODE, {
    message: REVALLE_ACCOUNT_REQUIRED_MESSAGE,
    userMessage: REVALLE_ACCOUNT_REQUIRED_MESSAGE,
    statusCode: 401,
  });

export const revalleAccountMismatchError = () =>
  new AppError(REVALLE_ACCOUNT_MISMATCH_CODE, {
    message: REVALLE_ACCOUNT_MISMATCH_MESSAGE,
    userMessage: REVALLE_ACCOUNT_MISMATCH_MESSAGE,
    statusCode: 403,
  });

/** Recusa a ação por token quando o destinatário é do e-mail da empresa e a sessão não é da conta dele. */
export const assertRevalleRecipientAccount = async (
  recipient: RevalleAccountRecipient,
  actor: RevalleSigningActor,
): Promise<void> => {
  const check = await getRevalleAccountCheck(recipient, actor);

  if (check.status === 'NO_SESSION') {
    throw revalleAccountRequiredError();
  }

  if (check.status === 'WRONG_USER') {
    throw revalleAccountMismatchError();
  }
};
