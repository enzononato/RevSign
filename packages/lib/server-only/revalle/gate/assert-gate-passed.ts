import { AppError, AppErrorCode } from '../../../errors/app-error';
import { getRevalleGateState } from './get-gate-state';
import type { RevalleGateRecipient } from './types';

export const assertRevalleGatePassed = async (recipient: RevalleGateRecipient): Promise<void> => {
  const state = await getRevalleGateState(recipient);

  if (state.status !== 'PASSED') {
    throw new AppError(AppErrorCode.UNAUTHORIZED, { message: 'Conclua a verificação antes de continuar.' });
  }
};
