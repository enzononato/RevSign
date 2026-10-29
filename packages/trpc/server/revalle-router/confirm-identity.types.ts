import { z } from 'zod';

import { ZRevalleGateStateSchema } from './gate-state.types';

export const ZConfirmIdentityRequestSchema = z.object({
  token: z.string().min(1),
  isMe: z.boolean(),
});

export const ZConfirmIdentityResponseSchema = ZRevalleGateStateSchema;

export type TConfirmIdentityRequest = z.infer<typeof ZConfirmIdentityRequestSchema>;
