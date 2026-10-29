import { z } from 'zod';

import { ZRevalleGateStateSchema } from './gate-state.types';

export const ZAcceptTermRequestSchema = z.object({
  token: z.string().min(1),
  termVersion: z.string().min(1),
});

export const ZAcceptTermResponseSchema = ZRevalleGateStateSchema;

export type TAcceptTermRequest = z.infer<typeof ZAcceptTermRequestSchema>;
