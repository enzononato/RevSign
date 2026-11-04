import { assertInvoiceEnvelopeAccess } from '@documenso/lib/server-only/revalle/invoice/access';
import { setInvoiceCostCenter } from '@documenso/lib/server-only/revalle/invoice/choice';

import { authenticatedProcedure } from '../../trpc';
import { ZSetInvoiceCostCenterRequestSchema, ZSetInvoiceCostCenterResponseSchema } from './set-cost-center.types';

/** Centro de custo da NF (lista fixa). Depois do envio, só a primeira escolha; quem corrige é a Contabilidade. */
export const setInvoiceCostCenterRoute = authenticatedProcedure
  .input(ZSetInvoiceCostCenterRequestSchema)
  .output(ZSetInvoiceCostCenterResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId, code } = input;

    await assertInvoiceEnvelopeAccess({ envelopeId, userId: ctx.user.id });

    return await setInvoiceCostCenter({
      envelopeId,
      code,
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
      requestMetadata: ctx.metadata.requestMetadata,
    });
  });
