import { z } from 'zod';

// REVALLE (v.21): contrato para colaboradores (só admin).

export const ZCollaboratorContractFromEnvelopeRequestSchema = z.object({
  /** O documento concluído (assinado pelo representante). */
  envelopeId: z.string().min(1),
  /** O time em que o modelo nasce (o time aberto pelo admin). */
  teamId: z.number(),
});

export const ZCollaboratorContractTemplateRequestSchema = z.object({
  templateEnvelopeId: z.string().min(1),
});

export const ZCollaboratorContractSetPausedRequestSchema = z.object({
  templateEnvelopeId: z.string().min(1),
  paused: z.boolean(),
});
