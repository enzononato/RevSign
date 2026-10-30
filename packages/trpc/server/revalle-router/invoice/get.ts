import { assertInvoiceEnvelopeAccess } from '@documenso/lib/server-only/revalle/invoice/access';
import { getInvoiceState } from '@documenso/lib/server-only/revalle/invoice/classify';

import { authenticatedProcedure } from '../../trpc';
import { ZGetInvoiceRequestSchema, ZGetInvoiceResponseSchema } from './get.types';

/** Estado da nota fiscal do documento (na primeira vez, classifica). A tela consulta enquanto está PENDING. */
export const getInvoiceRoute = authenticatedProcedure
  .input(ZGetInvoiceRequestSchema)
  .output(ZGetInvoiceResponseSchema)
  .query(async ({ input, ctx }) => {
    await assertInvoiceEnvelopeAccess({ envelopeId: input.envelopeId, userId: ctx.user.id });

    return await getInvoiceState(input.envelopeId, {
      userId: ctx.user.id,
      ipAddress: ctx.metadata.requestMetadata.ipAddress,
    });
  });
