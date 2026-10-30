import { findFinanceUsers } from '@documenso/lib/server-only/revalle/finance/members';
import { ZAdminListFinanceUsersRequestSchema, ZAdminListFinanceUsersResponseSchema } from './admin-list-users.types';
import { financeAdminProcedure } from './admin-procedure';

/** Tela Admin → Financeiro: usuários com a marca do perfil; busca por nome ou e-mail. */
export const adminListFinanceUsersRoute = financeAdminProcedure
  .input(ZAdminListFinanceUsersRequestSchema)
  .output(ZAdminListFinanceUsersResponseSchema)
  .query(async ({ input }) => {
    return { users: await findFinanceUsers({ query: input.query }) };
  });
