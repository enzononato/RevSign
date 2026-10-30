import { z } from 'zod';

export const ZInvoiceEnvelopeRequestSchema = z.object({ envelopeId: z.string().min(1) });

export const ZInvoiceStateSchema = z.object({
  isInvoice: z.enum(['YES', 'NO', 'UNKNOWN']),
  detectedBy: z.enum(['TEXT', 'SENDER']),
  suggestionStatus: z.enum(['PENDING', 'DONE', 'FAILED', 'SKIPPED']),
  suggestion: z
    .object({
      accountCode: z.string(),
      accountName: z.string(),
      confidence: z.enum(['alta', 'media', 'baixa']),
      reason: z.string(),
    })
    .nullable(),
  failureReason: z
    .enum([
      'TIMEOUT',
      'INVALID_RESPONSE',
      'UNKNOWN_ACCOUNT',
      'PROVIDER_ERROR',
      'NO_ACCOUNTS',
      'RATE_LIMITED',
      'NO_CONTENT',
    ])
    .nullable(),
  choice: z.object({ code: z.string(), name: z.string().optional() }).nullable(),
  aiAvailable: z.boolean(),
});

export type TInvoiceState = z.infer<typeof ZInvoiceStateSchema>;
