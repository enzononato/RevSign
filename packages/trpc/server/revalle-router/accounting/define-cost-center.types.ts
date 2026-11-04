import { z } from 'zod';

export const ZDefineCostCenterRequestSchema = z.object({
  envelopeId: z.string().min(1),
  code: z.string().trim().min(1).max(50),
});

export const ZDefineCostCenterResponseSchema = z.void();
