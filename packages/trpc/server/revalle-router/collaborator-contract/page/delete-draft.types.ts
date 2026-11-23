import { z } from 'zod';

import { ZContractIdSchema, ZOkResponseSchema } from './shared.types';

export const ZDeleteCollaboratorContractDraftRequestSchema = z.object({ contractId: ZContractIdSchema });

export const ZDeleteCollaboratorContractDraftResponseSchema = ZOkResponseSchema;
