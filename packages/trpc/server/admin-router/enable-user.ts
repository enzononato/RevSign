import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { reactivateRevalleUser } from '@documenso/lib/server-only/revalle/users/user-status'; // REVALLE:
import { getUserById } from '@documenso/lib/server-only/user/get-user-by-id';

import { adminProcedure } from '../trpc';
import { ZEnableUserRequestSchema, ZEnableUserResponseSchema } from './enable-user.types';

export const enableUserRoute = adminProcedure
  .input(ZEnableUserRequestSchema)
  .output(ZEnableUserResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { id } = input;

    ctx.logger.info({
      input: {
        id,
      },
    });

    const user = await getUserById({ id }).catch(() => null);

    if (!user) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'User not found',
      });
    }

    // REVALLE (v.26): ativar à mão é o "Reativar": registra quem reativou e liga "Mantido ativo pelo TI", para a
    // inativação pela folha não desativar de novo na noite seguinte. Usa o enableUser do upstream por dentro.
    await reactivateRevalleUser({ userId: id, actorId: ctx.user.id });
  });
