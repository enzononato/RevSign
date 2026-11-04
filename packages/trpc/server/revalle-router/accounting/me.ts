import { isAccountingMember } from '@documenso/lib/server-only/revalle/accounting/members';

import { authenticatedProcedure } from '../../trpc';
import { ZAccountingMeResponseSchema } from './me.types';

/** Se quem está logado é da Contabilidade (a tela usa para mostrar o que é do perfil; o servidor confere de novo). */
export const accountingMeRoute = authenticatedProcedure.output(ZAccountingMeResponseSchema).query(async ({ ctx }) => {
  return { isMember: await isAccountingMember(ctx.user.id) };
});
