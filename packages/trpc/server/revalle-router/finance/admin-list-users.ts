import { countInvoicesAwaitingAccount } from '@documenso/lib/server-only/revalle/finance/hold';
import { countFinanceMembers, findFinanceUsers } from '@documenso/lib/server-only/revalle/finance/members';
import { countInvoicesAwaitingApproval } from '@documenso/lib/server-only/revalle/finance/seal-hold';
import { ZAdminListFinanceUsersRequestSchema, ZAdminListFinanceUsersResponseSchema } from './admin-list-users.types';
import { financeAdminProcedure } from './admin-procedure';

/**
 * Tela Admin → Financeiro: usuários com a marca do perfil; busca por nome ou e-mail. Os números deixam a tela avisar
 * quando há NF esperando o Financeiro (a conta, ou a aprovação depois de todos assinarem) e ninguém no Financeiro.
 */
export const adminListFinanceUsersRoute = financeAdminProcedure
  .input(ZAdminListFinanceUsersRequestSchema)
  .output(ZAdminListFinanceUsersResponseSchema)
  .query(async ({ input }) => {
    const [users, memberCount, awaitingAccountCount, awaitingApprovalCount] = await Promise.all([
      findFinanceUsers({ query: input.query }),
      countFinanceMembers(),
      countInvoicesAwaitingAccount(),
      countInvoicesAwaitingApproval(),
    ]);

    return { users, memberCount, awaitingAccountCount, awaitingApprovalCount };
  });
