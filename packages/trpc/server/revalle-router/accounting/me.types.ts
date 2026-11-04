import { z } from 'zod';

export const ZAccountingMeResponseSchema = z.object({
  isMember: z.boolean(),
});

export type TAccountingMeResponse = z.infer<typeof ZAccountingMeResponseSchema>;
