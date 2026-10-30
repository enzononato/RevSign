import { countInvoicesAwaitingAccount } from '@documenso/lib/server-only/revalle/finance/hold';
import { countFinanceMembers, findFinanceUsers } from '@documenso/lib/server-only/revalle/finance/members';
import { ZAdminListFinanceUsersRequestSchema, ZAdminListFinanceUsersResponseSchema } from './admin-list-users.types';
import { financeAdminProcedure } from './admin-procedure';

/**
 * Tela Admin → Financeiro: usuários com a marca do perfil; busca por nome ou e-mail. Os números deixam a tela avisar
 * quando há NF retida esperando a conta e ninguém no Financeiro para definir.
 */
export const adminListFinanceUsersRoute = financeAdminProcedure
  .input(ZAdminListFinanceUsersRequestSchema)
  .output(ZAdminListFinanceUsersResponseSchema)
  .query(async ({ input }) => {
    const [users, memberCount, awaitingAccountCount] = await Promise.all([
      findFinanceUsers({ query: input.query }),
      countFinanceMembers(),
      countInvoicesAwaitingAccount(),
    ]);

    return { users, memberCount, awaitingAccountCount };
  });
