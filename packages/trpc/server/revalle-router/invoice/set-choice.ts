import { assertInvoiceEnvelopeAccess } from '@documenso/lib/server-only/revalle/invoice/access';
import { setInvoiceChoice } from '@documenso/lib/server-only/revalle/invoice/choice';

import { authenticatedProcedure } from '../../trpc';
import { ZSetInvoiceChoiceRequestSchema, ZSetInvoiceChoiceResponseSchema } from './set-choice.types';

/** Conta contábil da NF (ou "Deixar para a contabilidade decidir"). Depois do envio, só o dono e o admin trocam. */
export const setInvoiceChoiceRoute = authenticatedProcedure
  .input(ZSetInvoiceChoiceRequestSchema)
  .output(ZSetInvoiceChoiceResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId, choice } = input;

    await assertInvoiceEnvelopeAccess({ envelopeId, userId: ctx.user.id });

    return await setInvoiceChoice({
      envelopeId,
      choice,
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
      requestMetadata: ctx.metadata.requestMetadata,
    });
  });
