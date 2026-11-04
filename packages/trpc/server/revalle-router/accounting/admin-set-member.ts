import { setAccountingMember } from '@documenso/lib/server-only/revalle/accounting/members';

import { financeAdminProcedure } from '../finance/admin-procedure';
import {
  ZAdminSetAccountingMemberRequestSchema,
  ZAdminSetAccountingMemberResponseSchema,
} from './admin-set-member.types';

/** Marca ou desmarca alguém como da Contabilidade (só o admin; o mesmo portão do Financeiro: sem sessão 401, não admin 403). */
export const adminSetAccountingMemberRoute = financeAdminProcedure
  .input(ZAdminSetAccountingMemberRequestSchema)
  .output(ZAdminSetAccountingMemberResponseSchema)
  .mutation(async ({ input, ctx }) => {
    await setAccountingMember({ userId: input.userId, isMember: input.isMember, adminId: ctx.user.id });
  });
