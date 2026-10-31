import { isFinanceMember } from '@documenso/lib/server-only/revalle/finance/members';

import { authenticatedProcedure } from '../../trpc';
import { ZFinanceMeResponseSchema } from './me.types';

/** Se quem está logado é do Financeiro (a tela usa para mostrar o que é do perfil; o servidor confere de novo). */
export const financeMeRoute = authenticatedProcedure.output(ZFinanceMeResponseSchema).query(async ({ ctx }) => {
  return { isFinance: await isFinanceMember(ctx.user.id) };
});
