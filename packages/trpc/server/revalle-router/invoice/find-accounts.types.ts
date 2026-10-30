import { z } from 'zod';

export const ZFindInvoiceAccountsRequestSchema = z.object({}).optional();

export const ZFindInvoiceAccountsResponseSchema = z.object({
  accounts: z.array(z.object({ code: z.string(), name: z.string() })),
});
