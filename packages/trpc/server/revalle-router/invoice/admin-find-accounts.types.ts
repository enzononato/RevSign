import { z } from 'zod';

import { ZParsedAccountSchema } from './admin-preview-accounts.types';

export const ZAdminFindAccountsRequestSchema = z.object({
  query: z.string().max(200).optional(),
  includeInactive: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

export const ZAdminFindAccountsResponseSchema = z.object({
  accounts: z.array(ZParsedAccountSchema.extend({ active: z.boolean() })),
  total: z.number(),
});

export type TAdminFindAccountsRequest = z.infer<typeof ZAdminFindAccountsRequestSchema>;
