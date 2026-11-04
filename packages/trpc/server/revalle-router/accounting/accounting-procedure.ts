import { isAccountingMember } from '@documenso/lib/server-only/revalle/accounting/members';
import { TRPCError } from '@trpc/server';

import { authenticatedProcedure } from '../../trpc';

/**
 * Rotas só da Contabilidade (validar e corrigir o centro de custo): sem sessão = 401 (o `authenticatedProcedure` do
 * upstream); logado sem ser membro = 403, inclusive o admin que não foi marcado (como o `financeProcedure`). A marca é
 * lida do banco a cada pedido: quem sai do perfil perde as ações na hora.
 */
export const accountingProcedure = authenticatedProcedure.use(async ({ ctx, next }) => {
  if (!(await isAccountingMember(ctx.user.id))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Só quem é da Contabilidade pode fazer isso.' });
  }

  return await next();
});
