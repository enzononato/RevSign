import { z } from 'zod';

export const ZAdminSetFinanceMemberRequestSchema = z.object({
  userId: z.number().int().positive(),
  member: z.boolean(),
});

export const ZAdminSetFinanceMemberResponseSchema = z.void();
