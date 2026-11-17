import { assertInvoiceEnvelopeAccess } from '@documenso/lib/server-only/revalle/invoice/access';
import { setInvoiceFileKind } from '@documenso/lib/server-only/revalle/invoice/classify';

import { authenticatedProcedure } from '../../trpc';
import { ZSetInvoiceFileKindRequestSchema, ZSetInvoiceFileKindResponseSchema } from './set-file-kind.types';

/**
 * Fase 9: "Este arquivo é: Nota fiscal / Boleto / Outro", decidido pelo remetente num rascunho. "Nota fiscal" começa a
 * leitura da IA daquele arquivo; "Outro"/"Boleto" apaga a leitura e a escolha dele.
 */
export const setInvoiceFileKindRoute = authenticatedProcedure
  .input(ZSetInvoiceFileKindRequestSchema)
  .output(ZSetInvoiceFileKindResponseSchema)
  .mutation(async ({ input, ctx }) => {
    await assertInvoiceEnvelopeAccess({ envelopeId: input.envelopeId, userId: ctx.user.id });

    return await setInvoiceFileKind({
      envelopeId: input.envelopeId,
      envelopeItemId: input.envelopeItemId,
      kind: input.kind,
      requester: { userId: ctx.user.id, ipAddress: ctx.metadata.requestMetadata.ipAddress },
    });
  });
