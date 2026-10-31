import { AppError, AppErrorCode } from '../../../errors/app-error';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { getRevalleGateState } from './get-gate-state';
import { supersededVersionError } from './superseded-version';
import type { RevalleGateRecipient } from './types';

export const assertRevalleGatePassed = async (
  recipient: RevalleGateRecipient,
  requestMetadata?: RequestMetadata,
): Promise<void> => {
  const state = await getRevalleGateState(recipient, requestMetadata);

  if (state.status === 'SUPERSEDED') {
    throw supersededVersionError();
  }

  if (state.status !== 'PASSED') {
    throw new AppError(AppErrorCode.UNAUTHORIZED, { message: 'Conclua a verificação antes de continuar.' });
  }
};
