import { z } from 'zod';

import { ZContractIdSchema, ZOkResponseSchema } from './shared.types';

export const ZResendCollaboratorContractRepresentativeRequestSchema = z.object({ contractId: ZContractIdSchema });

export const ZResendCollaboratorContractRepresentativeResponseSchema = ZOkResponseSchema;
