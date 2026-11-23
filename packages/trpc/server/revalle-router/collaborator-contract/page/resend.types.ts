import { z } from 'zod';

import { ZContractIdSchema, ZOkResponseSchema } from './shared.types';

export const ZResendCollaboratorInviteRequestSchema = z.object({
  contractId: ZContractIdSchema,
  queueId: z.string().min(1).max(64),
});

export const ZResendCollaboratorInviteResponseSchema = ZOkResponseSchema;
