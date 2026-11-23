import { isAdmin } from '@documenso/lib/utils/is-admin';
import { prisma } from '@documenso/prisma';
import { TRPCError } from '@trpc/server';

import { authenticatedProcedure } from '../../../trpc';

/**
 * REVALLE (v.22): rotas da página "Contratos para colaboradores". Sem sessão = 401; logado sem o papel ADMIN = 403 (o
 * papel é lido do banco, como nas rotas de admin do Financeiro). A camada de baixo confere de novo.
 */
export const collaboratorContractPageProcedure = authenticatedProcedure.use(async ({ ctx, next }) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id }, select: { roles: true } });

  if (!isAdmin(user)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Só o administrador pode fazer isso.' });
  }

  return await next();
});
