import { z } from 'zod';

import { ZContractIdSchema, ZSignatureRectSchema } from './shared.types';

export const ZSaveCollaboratorContractDraftRequestSchema = z.object({
  /** Sem ele, nasce o rascunho. */
  contractId: ZContractIdSchema.optional(),
  data: z.object({
    title: z.string().trim().max(255).nullish(),
    senderName: z.string().trim().max(100).nullish(),
    documentDataId: z.string().min(1).max(64).nullish(),
    representativeEmail: z.string().trim().max(254).nullish(),
    representativeRect: ZSignatureRectSchema.nullish(),
    collaboratorRect: ZSignatureRectSchema.nullish(),
  }),
});

export const ZSaveCollaboratorContractDraftResponseSchema = z.object({ contractId: z.string() });
