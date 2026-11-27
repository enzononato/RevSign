import { getFinanceCard } from '@documenso/lib/server-only/revalle/finance/card';
import { assertInvoiceInUserScope } from '@documenso/lib/server-only/revalle/invoice/unit-scope';

import { financeProcedure } from './finance-procedure';
import { ZGetFinanceCardRequestSchema, ZGetFinanceCardResponseSchema } from './get.types';

/** Cartão "Financeiro" da página da NF (só membro do Financeiro): conta, quem escolheu, sugestão da IA e estado. */
export const getFinanceCardRoute = financeProcedure
  .input(ZGetFinanceCardRequestSchema)
  .output(ZGetFinanceCardResponseSchema)
  .query(async ({ input, ctx }) => {
    await assertInvoiceInUserScope({ envelopeId: input.envelopeId, userId: ctx.user.id });

    return await getFinanceCard(input.envelopeId, input.envelopeItemId);
  });
