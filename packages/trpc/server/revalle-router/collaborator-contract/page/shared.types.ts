import { ZSignatureRectSchema } from '@documenso/lib/revalle/collaborator-contract-rect';
import { z } from 'zod';

// REVALLE (v.22): partes comuns das rotas da página "Contratos para colaboradores".

export { ZSignatureRectSchema };

export const ZContractIdSchema = z.string().min(1).max(64);

export const ZContractStatusSchema = z.enum([
  'DRAFT',
  'AWAITING_REPRESENTATIVE',
  'SENDING',
  'PAUSED',
  'COMPLETED',
  'REJECTED_BY_REPRESENTATIVE',
]);

export const ZCollaboratorDocStatusSchema = z.enum(['QUEUED', 'FAILED', 'SENT', 'OPENED', 'SIGNED', 'REJECTED']);

export const ZOkResponseSchema = z.object({ ok: z.literal(true) });
