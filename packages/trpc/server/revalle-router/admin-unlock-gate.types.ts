import { z } from 'zod';

export const ZAdminUnlockGateRequestSchema = z.object({ gateId: z.string().min(1) });

export const ZAdminUnlockGateResponseSchema = z.void();

export type TAdminUnlockGateRequest = z.infer<typeof ZAdminUnlockGateRequestSchema>;
