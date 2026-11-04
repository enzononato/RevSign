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
  /** Fase 7: centro de custo (lista fixa), exigido junto com a conta no primeiro envio. */
  costCenter: z.object({ code: z.string(), name: z.string() }).nullable(),
  financeStatus: z.enum(['PENDING_APPROVAL', 'APPROVED', 'SUPERSEDED', 'LEGACY']).nullable(),
  /** `APPROVED` sem reserva de envio (`approvedAt` nulo): o envio da nova versão falhou e o rascunho pode ser enviado. */
  isFinanceSendReleased: z.boolean(),
  /** Versão substituída pelo Financeiro: a nova versão (link no cartão do remetente). */
  supersededByEnvelopeId: z.string().nullable(),
  aiAvailable: z.boolean(),
});

export type TInvoiceState = z.infer<typeof ZInvoiceStateSchema>;
