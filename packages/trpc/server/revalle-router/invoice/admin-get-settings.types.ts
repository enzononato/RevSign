import { z } from 'zod';

export const ZAdminGetSettingsRequestSchema = z.object({}).optional();

export const ZAdminGetSettingsResponseSchema = z.object({
  prompt: z.string(),
  accountingEmail: z.string().nullable(),
  updatedAt: z.date().nullable(),
  updatedBy: z.object({ name: z.string().nullable(), email: z.string() }).nullable(),
  aiStatus: z.enum(['CONFIGURED', 'NO_KEY', 'DISABLED']),
  model: z.string(),
});
