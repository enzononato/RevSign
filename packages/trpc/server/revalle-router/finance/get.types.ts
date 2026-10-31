import { FINANCE_STATUSES } from '@documenso/lib/revalle/finance/finance-status';
import { z } from 'zod';

export const ZGetFinanceCardRequestSchema = z.object({
  envelopeId: z.string().min(1),
});

export const ZGetFinanceCardResponseSchema = z.object({
  envelopeId: z.string(),
  envelopeStatus: z.enum(['DRAFT', 'PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED']),
  financeStatus: z.enum(FINANCE_STATUSES).nullable(),
  account: z.object({ code: z.string(), name: z.string().nullable() }).nullable(),
  deferred: z.boolean(),
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
  canRetakeChange: z.boolean(),
  rejected: z.boolean(),
});

export type TGetFinanceCardResponse = z.infer<typeof ZGetFinanceCardResponseSchema>;
