import { z } from 'zod';

export const ZInvoicePendingCountsResponseSchema = z.object({
  /** NFs aguardando o Financeiro; `null` quando a pessoa não é do Financeiro. */
  finance: z.number().int().nullable(),
  /** NFs aguardando a Contabilidade; `null` quando a pessoa não é da Contabilidade. */
  accounting: z.number().int().nullable(),
});

export type TInvoicePendingCountsResponse = z.infer<typeof ZInvoicePendingCountsResponseSchema>;
