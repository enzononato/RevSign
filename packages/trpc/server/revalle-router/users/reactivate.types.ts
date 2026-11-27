import { z } from 'zod';

export const ZRevalleReactivateUserRequestSchema = z.object({
  userId: z.number().int().positive(),
});

export const ZRevalleReactivateUserResponseSchema = z.void();
