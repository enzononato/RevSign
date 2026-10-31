import { setFinanceMember } from '@documenso/lib/server-only/revalle/finance/members';

import { financeAdminProcedure } from './admin-procedure';
import { ZAdminSetFinanceMemberRequestSchema, ZAdminSetFinanceMemberResponseSchema } from './admin-set-member.types';

/** Marca ou desmarca alguém como do Financeiro (só o admin). */
export const adminSetFinanceMemberRoute = financeAdminProcedure
  .input(ZAdminSetFinanceMemberRequestSchema)
  .output(ZAdminSetFinanceMemberResponseSchema)
  .mutation(async ({ input, ctx }) => {
    await setFinanceMember({ userId: input.userId, member: input.member, actorId: ctx.user.id });
  });
