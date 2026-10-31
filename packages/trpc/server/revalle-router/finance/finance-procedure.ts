import { isFinanceMember } from '@documenso/lib/server-only/revalle/finance/members';
import { TRPCError } from '@trpc/server';

import { authenticatedProcedure } from '../../trpc';

/**
 * Rotas só do Financeiro (definir, aprovar, trocar a conta): sem sessão = 401 (o `authenticatedProcedure` do upstream);
 * logado sem ser membro = 403. A marca é lida do banco a cada pedido: quem sai do perfil perde as ações na hora.
 */
export const financeProcedure = authenticatedProcedure.use(async ({ ctx, next }) => {
  if (!(await isFinanceMember(ctx.user.id))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Só quem é do Financeiro pode fazer isso.' });
  }

  return await next();
});
