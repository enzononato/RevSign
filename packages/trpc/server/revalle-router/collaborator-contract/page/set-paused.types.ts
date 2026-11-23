import { z } from 'zod';

import { ZContractIdSchema, ZOkResponseSchema } from './shared.types';

export const ZSetCollaboratorContractPausedRequestSchema = z.object({
  contractId: ZContractIdSchema,
  paused: z.boolean(),
});

export const ZSetCollaboratorContractPausedResponseSchema = ZOkResponseSchema;
