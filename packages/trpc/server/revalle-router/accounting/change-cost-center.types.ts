import { CHANGE_REASON_MESSAGE } from '@documenso/lib/revalle/finance/account-change';
import { z } from 'zod';

export const ZChangeCostCenterRequestSchema = z.object({
  envelopeId: z.string().min(1),
  code: z.string().trim().min(1).max(50),
  reason: z.string().trim().min(10, CHANGE_REASON_MESSAGE).max(500, CHANGE_REASON_MESSAGE),
});

export const ZChangeCostCenterResponseSchema = z.object({
  /** A nova versão da NF (com o centro novo, validado), enviada para todos assinarem de novo. */
  newEnvelopeId: z.string(),
});

export type TChangeCostCenterResponse = z.infer<typeof ZChangeCostCenterResponseSchema>;
