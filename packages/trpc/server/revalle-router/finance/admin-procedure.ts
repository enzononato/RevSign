import { isAdmin } from '@documenso/lib/utils/is-admin';
import { prisma } from '@documenso/prisma';
import { TRPCError } from '@trpc/server';

import { authenticatedProcedure } from '../../trpc';

/**
 * Rotas de admin do Financeiro: sem sessão = 401 (o `authenticatedProcedure` do upstream, que também barra conta
 * desativada e sessão embutida); logado sem o papel ADMIN = 403. O `adminProcedure` do upstream responde 401 nos dois
 * casos. O papel é lido do banco (o tipo de `ctx.user` não traz `roles`), como em `revalle.invoice.find`.
 */
export const financeAdminProcedure = authenticatedProcedure.use(async ({ ctx, next }) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id }, select: { roles: true } });

  if (!isAdmin(user)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Só o administrador pode fazer isso.' });
  }

  return await next();
});
