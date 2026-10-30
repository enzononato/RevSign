import { z } from 'zod';

export const ZAdminUpdateSettingsRequestSchema = z.object({
  prompt: z.string().max(10_000),
  accountingEmail: z.union([z.literal(''), z.string().trim().toLowerCase().email().max(254)]),
});

export const ZAdminUpdateSettingsResponseSchema = z.void();

export type TAdminUpdateSettingsRequest = z.infer<typeof ZAdminUpdateSettingsRequestSchema>;
