import { z } from 'zod';

/** Fase 8: fornecedor, número e valor que a IA leu da NF (podem estar errados; a tela diz que vieram da IA). */
export const ZInvoiceDataSummarySchema = z.object({
  supplierName: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  totalAmountCents: z.number().nullable(),
});

/**
 * Fase 8: outra NF viva com uma chave em comum ou o mesmo arquivo. Sem título nem id de propósito: quem vê o estado (o
 * remetente que vai enviar) pode não ter acesso à outra nota.
 */
export const ZInvoiceDuplicateSummarySchema = z.object({
  sentAt: z.date().nullable(),
  senderName: z.string(),
  status: z.enum(['PENDING', 'COMPLETED']),
});

export const ZInvoiceEnvelopeRequestSchema = z.object({ envelopeId: z.string().min(1) });

/**
 * Fase 9: as rotas que gravam "da nota" aceitam o arquivo da nota. Sem ele, valem quando o envio tem uma nota só; com 2+
 * notas, 400 `INVOICE_FILE_REQUIRED`.
 */
export const ZInvoiceFileRequestSchema = ZInvoiceEnvelopeRequestSchema.extend({
  envelopeItemId: z.string().min(1).optional(),
});

const ZInvoiceSuggestionSchema = z
  .object({
    accountCode: z.string(),
    accountName: z.string(),
    confidence: z.enum(['alta', 'media', 'baixa']),
    reason: z.string(),
  })
  .nullable();

const ZInvoiceFailureReasonSchema = z
  .enum([
    'TIMEOUT',
    'INVALID_RESPONSE',
    'UNKNOWN_ACCOUNT',
    'PROVIDER_ERROR',
    'NO_ACCOUNTS',
    'RATE_LIMITED',
    'NO_CONTENT',
  ])
  .nullable();

const ZInvoiceChoiceSchema = z.object({ code: z.string(), name: z.string().optional() }).nullable();

const ZInvoiceCostCenterSchema = z.object({ code: z.string(), name: z.string() }).nullable();

/** Fase 9: um arquivo do envio (na ordem dos arquivos), com o tipo e o que é "da nota". */
export const ZInvoiceDocumentStateSchema = z.object({
  envelopeItemId: z.string(),
  title: z.string(),
  order: z.number(),
  kind: z.enum(['NF', 'BOLETO', 'OTHER', 'UNKNOWN']),
  detectedBy: z.enum(['TEXT', 'SENDER']),
  /** Só NF: a posição entre as notas do envio. */
  position: z.object({ index: z.number(), total: z.number() }).nullable(),
  suggestionStatus: z.enum(['PENDING', 'DONE', 'FAILED', 'SKIPPED']),
  suggestion: ZInvoiceSuggestionSchema,
  failureReason: ZInvoiceFailureReasonSchema,
  invoiceData: ZInvoiceDataSummarySchema.nullable(),
  duplicates: z.array(ZInvoiceDuplicateSummarySchema),
  duplicateInEnvelope: z.object({ index: z.number() }).nullable(),
  choice: ZInvoiceChoiceSchema,
  costCenter: ZInvoiceCostCenterSchema,
  boleto: z.null(),
});

export const ZInvoiceStateSchema = z.object({
  isInvoice: z.enum(['YES', 'NO', 'UNKNOWN']),
  detectedBy: z.enum(['TEXT', 'SENDER']),
  suggestionStatus: z.enum(['PENDING', 'DONE', 'FAILED', 'SKIPPED']),
  suggestion: ZInvoiceSuggestionSchema,
  failureReason: ZInvoiceFailureReasonSchema,
  /** Nulo quando os três estão vazios. */
  invoiceData: ZInvoiceDataSummarySchema.nullable(),
  /** Fase 8: as outras notas que esta parece repetir (do envio mais antigo ao mais novo, até 5); vazio se não há. */
  duplicates: z.array(ZInvoiceDuplicateSummarySchema),
  choice: ZInvoiceChoiceSchema,
  /** Fase 7: centro de custo (lista fixa), exigido junto com a conta no primeiro envio. */
  costCenter: ZInvoiceCostCenterSchema,
  financeStatus: z.enum(['PENDING_APPROVAL', 'APPROVED', 'SUPERSEDED', 'LEGACY']).nullable(),
  /** Nova versão em rascunho cujo envio falhou: o rascunho pode ser enviado, com a conta e o centro travados. */
  isFinanceSendReleased: z.boolean(),
  /** Versão substituída: a nova versão (link no cartão do remetente) e o que mudou. */
  supersededByEnvelopeId: z.string().nullable(),
  supersedeKind: z.enum(['ACCOUNT', 'COST_CENTER']).nullable(),
  aiAvailable: z.boolean(),
  /**
   * Fase 9: cada arquivo do envio. Os campos de cima: com uma nota, os dela (como antes); com 2+ notas, a situação da IA
   * agregada, a união das duplicadas e o resto nulo.
   */
  documents: z.array(ZInvoiceDocumentStateSchema),
});

export type TInvoiceState = z.infer<typeof ZInvoiceStateSchema>;
