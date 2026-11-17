import { FINANCE_STATUSES } from '@documenso/lib/revalle/finance/finance-status';
import { z } from 'zod';

export const ZGetFinanceCardRequestSchema = z.object({
  envelopeId: z.string().min(1),
  /** Fase 9: a nota (o arquivo). Obrigatório com 2+ notas (senão 400 `INVOICE_FILE_REQUIRED`); sem ele, a nota única. */
  envelopeItemId: z.string().min(1).optional(),
});

export const ZGetFinanceCardResponseSchema = z.object({
  envelopeId: z.string(),
  /** Fase 9: a nota do cartão (o arquivo), o título dele e a posição entre as notas do envio. */
  envelopeItemId: z.string(),
  documentTitle: z.string(),
  position: z.object({ index: z.number(), total: z.number() }),
  envelopeStatus: z.enum(['DRAFT', 'PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED']),
  financeStatus: z.enum(FINANCE_STATUSES).nullable(),
  account: z.object({ code: z.string(), name: z.string().nullable() }).nullable(),
  costCenterLabel: z.string().nullable(),
  choiceBy: z.string().nullable(),
  choiceAt: z.date().nullable(),
  suggestion: z
    .object({ code: z.string(), name: z.string().nullable(), confidence: z.string(), reason: z.string() })
    .nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.date().nullable(),
  version: z.number(),
  previousEnvelopeId: z.string().nullable(),
  supersededByEnvelopeId: z.string().nullable(),
  supersedeReason: z.string().nullable(),
  supersedeKind: z.enum(['ACCOUNT', 'COST_CENTER']).nullable(),
  canRetakeChange: z.boolean(),
  rejected: z.boolean(),
});

export type TGetFinanceCardResponse = z.infer<typeof ZGetFinanceCardResponseSchema>;
