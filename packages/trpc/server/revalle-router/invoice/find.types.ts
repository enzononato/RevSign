import { FINANCE_STATUSES } from '@documenso/lib/revalle/finance/finance-status';
import { INVOICE_ROW_STATUSES, ZInvoiceFiltersSchema } from '@documenso/lib/revalle/invoice/invoice-filters';
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
  /** Nula para o rascunho que está com o Financeiro (ainda não enviado). */
  sentAt: z.date().nullable(),
  completedAt: z.date().nullable(),
  status: z.enum(INVOICE_ROW_STATUSES),
  deleted: z.boolean(),
  account: z.object({ code: z.string(), name: z.string().nullable() }).nullable(),
  accountKind: z.enum(['PAYABLE', 'RECEIVABLE']).nullable(),
  deferred: z.boolean(),
  suggestion: z.object({ code: z.string(), confidence: z.string() }).nullable(),
  acceptedSuggestion: z.boolean().nullable(),
  financeStatus: z.enum(FINANCE_STATUSES).nullable(),
  version: z.number(),
  approvedBy: z.string().nullable(),
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
