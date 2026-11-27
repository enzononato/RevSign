import { setRevalleKeepActive } from '@documenso/lib/server-only/revalle/users/user-status';

import { adminProcedure } from '../../trpc';
import { ZRevalleSetKeepActiveRequestSchema, ZRevalleSetKeepActiveResponseSchema } from './set-keep-active.types';

/** REVALLE (v.26): liga ou desliga "Mantido ativo pelo TI" (a folha não inativa quem tem a marca). Só admin. */
export const revalleSetKeepActiveRoute = adminProcedure
  .input(ZRevalleSetKeepActiveRequestSchema)
  .output(ZRevalleSetKeepActiveResponseSchema)
  .mutation(async ({ input, ctx }) => {
    ctx.logger.info({ input: { userId: input.userId, keepActive: input.keepActive } });

    await setRevalleKeepActive({ userId: input.userId, keepActive: input.keepActive, actorId: ctx.user.id });
  });
