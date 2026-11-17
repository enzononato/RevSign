import { FINANCE_STATUSES } from '@documenso/lib/revalle/finance/finance-status';
import { z } from 'zod';

export const ZGetAccountingCardRequestSchema = z.object({
  envelopeId: z.string().min(1),
  /** Fase 9: a nota (o arquivo). Obrigatório com 2+ notas (senão 400 `INVOICE_FILE_REQUIRED`); sem ele, a nota única. */
  envelopeItemId: z.string().min(1).optional(),
});

export const ZGetAccountingCardResponseSchema = z.object({
  envelopeId: z.string(),
  /** Fase 9: a nota do cartão (o arquivo), o título dele e a posição entre as notas do envio. */
  envelopeItemId: z.string(),
  documentTitle: z.string(),
  position: z.object({ index: z.number(), total: z.number() }),
  envelopeStatus: z.enum(['DRAFT', 'PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED']),
  financeStatus: z.enum(FINANCE_STATUSES).nullable(),
  costCenter: z.object({ code: z.string(), name: z.string() }).nullable(),
  validatedBy: z.string().nullable(),
  validatedAt: z.date().nullable(),
  version: z.number(),
  previousEnvelopeId: z.string().nullable(),
  supersededByEnvelopeId: z.string().nullable(),
  supersedeReason: z.string().nullable(),
  supersedeKind: z.enum(['ACCOUNT', 'COST_CENTER']).nullable(),
  canRetakeChange: z.boolean(),
  rejected: z.boolean(),
});

export type TGetAccountingCardResponse = z.infer<typeof ZGetAccountingCardResponseSchema>;
