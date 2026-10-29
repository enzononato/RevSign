import { z } from 'zod';

export const ZRecipientLinkStatusRequestSchema = z.object({
  emails: z.array(z.string().max(254)).max(100),
});

export const ZRecipientLinkStatusResponseSchema = z.array(z.object({ email: z.string(), isLinked: z.boolean() }));

export type TRecipientLinkStatusRequest = z.infer<typeof ZRecipientLinkStatusRequestSchema>;
