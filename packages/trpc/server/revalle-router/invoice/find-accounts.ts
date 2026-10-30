import { MAX_ACCOUNTS } from '@documenso/lib/server-only/revalle/invoice/accounts';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../../trpc';
import { ZFindInvoiceAccountsRequestSchema, ZFindInvoiceAccountsResponseSchema } from './find-accounts.types';

/** Contas ativas para a escolha na tela (a lista inteira: a busca por número ou nome é feita no navegador). */
export const findInvoiceAccountsRoute = authenticatedProcedure
  .input(ZFindInvoiceAccountsRequestSchema)
  .output(ZFindInvoiceAccountsResponseSchema)
  .query(async () => {
    const accounts = await prisma.revalleAccountingAccount.findMany({
      where: { active: true },
      orderBy: { code: 'asc' },
      take: MAX_ACCOUNTS,
      select: { code: true, name: true },
    });

    return { accounts };
  });
