import { z } from 'zod';

export const ZAdminUpdateSettingsRequestSchema = z.object({
  prompt: z.string().max(10_000),
});

export const ZAdminUpdateSettingsResponseSchema = z.void();

export type TAdminUpdateSettingsRequest = z.infer<typeof ZAdminUpdateSettingsRequestSchema>;
