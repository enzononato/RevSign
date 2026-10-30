import { findInvoices } from '@documenso/lib/server-only/revalle/invoice/find-invoices';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../../trpc';
import { ZFindInvoicesRequestSchema, ZFindInvoicesResponseSchema } from './find.types';

/** Página "Notas fiscais": NFs enviadas que o usuário pode ver (dono, destinatário pelo e-mail; o admin vê todas). */
export const findInvoicesRoute = authenticatedProcedure
  .input(ZFindInvoicesRequestSchema)
  .output(ZFindInvoicesResponseSchema)
  .query(async ({ input, ctx }) => {
    const { page, perPage, ...filters } = input;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id }, select: { roles: true } });

    return await findInvoices({ userId: ctx.user.id, isAdmin: isAdmin(user), filters, page, perPage });
  });
