import { countAccountingMembers } from '@documenso/lib/server-only/revalle/accounting/members';
import { countFinanceMembers, findProfileUsers } from '@documenso/lib/server-only/revalle/finance/members';
import { countInvoicesAwaitingApproval } from '@documenso/lib/server-only/revalle/finance/seal-hold';
import { ZAdminListFinanceUsersRequestSchema, ZAdminListFinanceUsersResponseSchema } from './admin-list-users.types';
import { financeAdminProcedure } from './admin-procedure';

/**
 * Tela Admin → Perfis: usuários com a marca de cada perfil (Financeiro e Contabilidade); busca por nome ou e-mail. Fica
 * no roteador do Financeiro por compatibilidade com a Fase 6. Os números deixam a tela avisar quando há NF esperando a
 * aprovação do Financeiro (depois de todos assinarem) e quando ninguém está em um dos perfis.
 */
export const adminListFinanceUsersRoute = financeAdminProcedure
  .input(ZAdminListFinanceUsersRequestSchema)
  .output(ZAdminListFinanceUsersResponseSchema)
  .query(async ({ input }) => {
    const [users, memberCount, accountingMemberCount, awaitingApprovalCount] = await Promise.all([
      findProfileUsers({ query: input.query }),
      countFinanceMembers(),
      countAccountingMembers(),
      countInvoicesAwaitingApproval(),
    ]);

    return { users, memberCount, accountingMemberCount, awaitingApprovalCount };
  });
