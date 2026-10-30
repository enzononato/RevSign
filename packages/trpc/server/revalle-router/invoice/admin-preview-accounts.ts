import { previewAccountsCsv } from '@documenso/lib/server-only/revalle/invoice/accounts';

import { adminProcedure } from '../../trpc';
import {
  ZAdminPreviewAccountsRequestSchema,
  ZAdminPreviewAccountsResponseSchema,
} from './admin-preview-accounts.types';

export const adminPreviewAccountsRoute = adminProcedure
  .input(ZAdminPreviewAccountsRequestSchema)
  .output(ZAdminPreviewAccountsResponseSchema)
  .mutation(({ input }) => {
    return previewAccountsCsv(input);
  });
