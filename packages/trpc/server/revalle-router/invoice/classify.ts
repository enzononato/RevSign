import { assertInvoiceEnvelopeAccess } from '@documenso/lib/server-only/revalle/invoice/access';
import { classifyEnvelope } from '@documenso/lib/server-only/revalle/invoice/classify';

import { authenticatedProcedure } from '../../trpc';
import { ZClassifyInvoiceRequestSchema, ZClassifyInvoiceResponseSchema } from './classify.types';

/** Confere de novo os arquivos (idempotente): só refaz a detecção se algum arquivo mudou. */
export const classifyInvoiceRoute = authenticatedProcedure
  .input(ZClassifyInvoiceRequestSchema)
  .output(ZClassifyInvoiceResponseSchema)
  .mutation(async ({ input, ctx }) => {
    await assertInvoiceEnvelopeAccess({ envelopeId: input.envelopeId, userId: ctx.user.id });

    return await classifyEnvelope(input.envelopeId, {
      userId: ctx.user.id,
      ipAddress: ctx.metadata.requestMetadata.ipAddress,
    });
  });
