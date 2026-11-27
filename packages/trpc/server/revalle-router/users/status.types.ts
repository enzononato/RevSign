import { z } from 'zod';

export const ZRevalleUserStatusRequestSchema = z.object({
  userId: z.number().int().positive(),
});

export const ZRevalleUserStatusResponseSchema = z.object({
  disabled: z.boolean(),
  hrInactivated: z.boolean(),
  keepActive: z.boolean(),
});

export type TRevalleUserStatusResponse = z.infer<typeof ZRevalleUserStatusResponseSchema>;
