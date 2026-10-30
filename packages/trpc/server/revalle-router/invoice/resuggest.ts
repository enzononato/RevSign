import { assertInvoiceEnvelopeAccess } from '@documenso/lib/server-only/revalle/invoice/access';
import { getInvoiceState } from '@documenso/lib/server-only/revalle/invoice/classify';
import { resuggestInvoice } from '@documenso/lib/server-only/revalle/invoice/suggest';

import { authenticatedProcedure } from '../../trpc';
import { ZResuggestInvoiceRequestSchema, ZResuggestInvoiceResponseSchema } from './resuggest.types';

/** "Sugerir de novo": nova chamada à IA, ignorando o cache. 5 por documento e 60 por usuário por hora (429). */
export const resuggestInvoiceRoute = authenticatedProcedure
  .input(ZResuggestInvoiceRequestSchema)
  .output(ZResuggestInvoiceResponseSchema)
  .mutation(async ({ input, ctx }) => {
    await assertInvoiceEnvelopeAccess({ envelopeId: input.envelopeId, userId: ctx.user.id });

    const requester = { userId: ctx.user.id, ipAddress: ctx.metadata.requestMetadata.ipAddress };

    await resuggestInvoice({ envelopeId: input.envelopeId, requester });

    return await getInvoiceState(input.envelopeId, requester);
  });
