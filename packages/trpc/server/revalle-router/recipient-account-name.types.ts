import { z } from 'zod';

export const ZRecipientAccountNameRequestSchema = z.object({
  email: z.string().max(254),
});

export const ZRecipientAccountNameResponseSchema = z.object({ name: z.string().nullable() });

export type TRecipientAccountNameRequest = z.infer<typeof ZRecipientAccountNameRequestSchema>;
