import { z } from 'zod';

export const ZRevalleSetKeepActiveRequestSchema = z.object({
  userId: z.number().int().positive(),
  keepActive: z.boolean(),
});

export const ZRevalleSetKeepActiveResponseSchema = z.void();
