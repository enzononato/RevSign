import { INVOICE_LIST_STATUSES, ZInvoiceFiltersSchema } from '@documenso/lib/revalle/invoice/invoice-filters';
import { z } from 'zod';

export const ZFindInvoicesRequestSchema = ZInvoiceFiltersSchema.extend({
  page: z.number().int().min(1).default(1),
  perPage: z.number().int().min(1).max(100).default(20),
});

export const ZInvoiceListRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  senderName: z.string(),
  senderEmail: z.string(),
  sentAt: z.date(),
  completedAt: z.date().nullable(),
  status: z.enum(INVOICE_LIST_STATUSES),
  account: z.object({ code: z.string(), name: z.string().nullable() }).nullable(),
  accountKind: z.enum(['PAYABLE', 'RECEIVABLE']).nullable(),
  deferred: z.boolean(),
  suggestion: z.object({ code: z.string(), confidence: z.string() }).nullable(),
  acceptedSuggestion: z.boolean().nullable(),
  link: z.string().nullable(),
});

export const ZFindInvoicesResponseSchema = z.object({
  data: z.array(ZInvoiceListRowSchema),
  count: z.number(),
  currentPage: z.number(),
  perPage: z.number(),
  totalPages: z.number(),
});

export type TFindInvoicesResponse = z.infer<typeof ZFindInvoicesResponseSchema>;
