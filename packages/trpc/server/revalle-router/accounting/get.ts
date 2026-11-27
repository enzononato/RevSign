import { getAccountingCard } from '@documenso/lib/server-only/revalle/accounting/card';
import { assertInvoiceInUserScope } from '@documenso/lib/server-only/revalle/invoice/unit-scope';

import { accountingProcedure } from './accounting-procedure';
import { ZGetAccountingCardRequestSchema, ZGetAccountingCardResponseSchema } from './get.types';

/** Cartão "Contabilidade" da página da NF (só membro da Contabilidade): o centro, a validação e as versões. */
export const getAccountingCardRoute = accountingProcedure
  .input(ZGetAccountingCardRequestSchema)
  .output(ZGetAccountingCardResponseSchema)
  .query(async ({ input, ctx }) => {
    await assertInvoiceInUserScope({ envelopeId: input.envelopeId, userId: ctx.user.id });

    return await getAccountingCard(input.envelopeId, input.envelopeItemId);
  });
