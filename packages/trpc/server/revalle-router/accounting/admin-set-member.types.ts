import { z } from 'zod';

export const ZAdminSetAccountingMemberRequestSchema = z.object({
  userId: z.number().int().positive(),
  isMember: z.boolean(),
});

export const ZAdminSetAccountingMemberResponseSchema = z.void();
