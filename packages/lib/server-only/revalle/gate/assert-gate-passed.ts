import { AppError, AppErrorCode } from '../../../errors/app-error';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { assertRevalleRecipientAccount, type RevalleSigningActor } from '../account-required/account-required';
import { getRevalleGateState } from './get-gate-state';
import { supersededVersionError } from './superseded-version';
import type { RevalleGateRecipient } from './types';

/**
 * Toda ação por token passa aqui. `actor` é a sessão do pedido: o destinatário do e-mail da empresa só age logado na
 * conta do próprio e-mail (conta obrigatória, 16/11/2026); sem sessão, REVALLE_ACCOUNT_REQUIRED (401), com outra conta,
 * REVALLE_ACCOUNT_MISMATCH (403). Obrigatório de propósito: quem chama precisa dizer quem é a sessão.
 */
export const assertRevalleGatePassed = async (
  recipient: RevalleGateRecipient,
  requestMetadata: RequestMetadata | undefined,
  actor: RevalleSigningActor,
): Promise<void> => {
  await assertRevalleRecipientAccount(recipient, actor);

  const state = await getRevalleGateState(recipient, requestMetadata);

  if (state.status === 'SUPERSEDED') {
    throw supersededVersionError();
  }

  if (state.status !== 'PASSED') {
    throw new AppError(AppErrorCode.UNAUTHORIZED, { message: 'Conclua a verificação antes de continuar.' });
  }
};
