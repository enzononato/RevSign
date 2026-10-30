import { assertInvoiceEnvelopeAccess } from '@documenso/lib/server-only/revalle/invoice/access';
import { markSentEnvelopeAsInvoice } from '@documenso/lib/server-only/revalle/invoice/mark-sent';

import { authenticatedProcedure } from '../../trpc';
import { ZMarkAsInvoiceRequestSchema, ZMarkAsInvoiceResponseSchema } from './mark-as-invoice.types';

/**
 * Documento já enviado que não ficou como NF: o dono ou o admin marca como nota fiscal (sem IA; a classificação
 * continua congelada). A conta é escolhida em seguida (`setChoice`).
 */
export const markAsInvoiceRoute = authenticatedProcedure
  .input(ZMarkAsInvoiceRequestSchema)
  .output(ZMarkAsInvoiceResponseSchema)
  .mutation(async ({ input, ctx }) => {
    await assertInvoiceEnvelopeAccess({ envelopeId: input.envelopeId, userId: ctx.user.id });

    return await markSentEnvelopeAsInvoice({ envelopeId: input.envelopeId, user: { id: ctx.user.id } });
  });
