import { findAccounts } from '@documenso/lib/server-only/revalle/invoice/accounts';

import { adminProcedure } from '../../trpc';
import { ZAdminFindAccountsRequestSchema, ZAdminFindAccountsResponseSchema } from './admin-find-accounts.types';

export const adminFindAccountsRoute = adminProcedure
  .input(ZAdminFindAccountsRequestSchema)
  .output(ZAdminFindAccountsResponseSchema)
  .query(async ({ input }) => {
    return await findAccounts(input);
  });
