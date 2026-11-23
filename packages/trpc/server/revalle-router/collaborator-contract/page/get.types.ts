import { z } from 'zod';

import { ZContractIdSchema, ZContractStatusSchema, ZSignatureRectSchema } from './shared.types';

export const ZGetCollaboratorContractRequestSchema = z.object({ contractId: ZContractIdSchema });

export const ZGetCollaboratorContractResponseSchema = z.object({
  contract: z.object({
    id: z.string(),
    title: z.string(),
    status: ZContractStatusSchema,
    paused: z.boolean(),
    senderName: z.string().nullable(),
    representativeEmail: z.string().nullable(),
    documentDataId: z.string().nullable(),
    representativeRect: ZSignatureRectSchema.nullable(),
    collaboratorRect: ZSignatureRectSchema.nullable(),
    total: z.number(),
    /** Os documentos ainda estão sendo criados (depois que o representante assinou). */
    isBuilding: z.boolean(),
    isLegacy: z.boolean(),
    createdAt: z.date(),
  }),
  /** Grupos que não se repetem: a soma (sem `notCreated`) é o total de documentos criados. */
  counts: z.object({
    queued: z.number(),
    sent: z.number(),
    viewed: z.number(),
    signed: z.number(),
    rejected: z.number(),
    failed: z.number(),
    /** Linhas da lista que não viraram documento (erro ao criar); não aparecem em `rows`. */
    notCreated: z.number(),
  }),
  representative: z
    .object({
      status: z.enum(['NOT_SENT', 'SENT', 'OPENED', 'SIGNED', 'REJECTED']),
      signedAt: z.date().nullable(),
      name: z.string(),
      email: z.string(),
      envelopeId: z.string(),
      teamUrl: z.string(),
    })
    .nullable(),
});
