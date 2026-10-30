import { z } from 'zod';

import { ZAccountsCsvInputSchema } from './admin-preview-accounts.types';

export const ZAdminImportAccountsRequestSchema = ZAccountsCsvInputSchema;

export const ZAdminImportAccountsResponseSchema = z.object({
  created: z.number(),
  updated: z.number(),
  deactivated: z.number(),
});

export type TAdminImportAccountsRequest = z.infer<typeof ZAdminImportAccountsRequestSchema>;
