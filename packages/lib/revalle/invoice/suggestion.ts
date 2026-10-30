import { z } from 'zod';

export const INVOICE_REASON_MAX_LENGTH = 200;

export const ZInvoiceSuggestionSchema = z.object({
  accountCode: z.string().trim().min(1),
  confidence: z.enum(['alta', 'media', 'baixa']),
  reason: z
    .string()
    .trim()
    .transform((reason) => reason.slice(0, INVOICE_REASON_MAX_LENGTH)),
});

export type InvoiceSuggestion = z.infer<typeof ZInvoiceSuggestionSchema>;

export const validateSuggestion = (raw: unknown, activeCodes: Set<string>): InvoiceSuggestion | null => {
  let candidate = raw;

  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  const parsed = ZInvoiceSuggestionSchema.safeParse(candidate);

  if (!parsed.success || !activeCodes.has(parsed.data.accountCode)) {
    return null;
  }

  return parsed.data;
};
