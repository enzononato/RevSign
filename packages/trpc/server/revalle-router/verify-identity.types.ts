import { z } from 'zod';

import { ZRevalleGateStateSchema } from './gate-state.types';

export const ZVerifyIdentityRequestSchema = z.object({
  token: z.string().min(1),
  cpf: z.string().max(32),
  birthDate: z.string().max(32),
});

export const ZVerifyIdentityResponseSchema = ZRevalleGateStateSchema;

export type TVerifyIdentityRequest = z.infer<typeof ZVerifyIdentityRequestSchema>;
