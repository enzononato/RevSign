import { FINANCE_STATUSES } from '@documenso/lib/revalle/finance/finance-status';
import { z } from 'zod';

export const ZGetAccountingCardRequestSchema = z.object({
  envelopeId: z.string().min(1),
});

export const ZGetAccountingCardResponseSchema = z.object({
  envelopeId: z.string(),
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
