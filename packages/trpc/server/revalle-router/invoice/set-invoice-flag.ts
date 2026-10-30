import { assertInvoiceEnvelopeAccess } from '@documenso/lib/server-only/revalle/invoice/access';
import { setInvoiceFlag } from '@documenso/lib/server-only/revalle/invoice/classify';

import { authenticatedProcedure } from '../../trpc';
import { ZSetInvoiceFlagRequestSchema, ZSetInvoiceFlagResponseSchema } from './set-invoice-flag.types';

/** "É nota fiscal?" decidido pelo remetente. "Sim" começa a sugestão (com o PDF quando não há texto). */
export const setInvoiceFlagRoute = authenticatedProcedure
  .input(ZSetInvoiceFlagRequestSchema)
  .output(ZSetInvoiceFlagResponseSchema)
  .mutation(async ({ input, ctx }) => {
    await assertInvoiceEnvelopeAccess({ envelopeId: input.envelopeId, userId: ctx.user.id });

    return await setInvoiceFlag({
      envelopeId: input.envelopeId,
      isInvoice: input.isInvoice,
      requester: { userId: ctx.user.id, ipAddress: ctx.metadata.requestMetadata.ipAddress },
    });
  });
