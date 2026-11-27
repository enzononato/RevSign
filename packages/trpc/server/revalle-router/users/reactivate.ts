import { reactivateRevalleUser } from '@documenso/lib/server-only/revalle/users/user-status';

import { adminProcedure } from '../../trpc';
import { ZRevalleReactivateUserRequestSchema, ZRevalleReactivateUserResponseSchema } from './reactivate.types';

/** REVALLE (v.26): "Reativar". Reativa, liga "Mantido ativo pelo TI" e registra quem reativou. Só admin. */
export const revalleReactivateUserRoute = adminProcedure
  .input(ZRevalleReactivateUserRequestSchema)
  .output(ZRevalleReactivateUserResponseSchema)
  .mutation(async ({ input, ctx }) => {
    ctx.logger.info({ input: { userId: input.userId } });

    await reactivateRevalleUser({ userId: input.userId, actorId: ctx.user.id });
  });
