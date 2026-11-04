import { z } from 'zod';

export const ZValidateCostCenterRequestSchema = z.object({
  envelopeId: z.string().min(1),
});

export const ZValidateCostCenterResponseSchema = z.object({
  /** `false`: o centro já estava validado; nada foi gravado. */
  validated: z.boolean(),
});

export type TValidateCostCenterResponse = z.infer<typeof ZValidateCostCenterResponseSchema>;
