import { approveInvoiceAccount } from '@documenso/lib/server-only/revalle/finance/approve';
import { assertInvoiceInUserScope } from '@documenso/lib/server-only/revalle/invoice/unit-scope';

import { ZApproveFinanceAccountRequestSchema, ZApproveFinanceAccountResponseSchema } from './approve.types';
import { financeProcedure } from './finance-procedure';

/**
 * "Aprovar conta" (ou "Definir e aprovar", com `code`, numa NF enviada sem conta): NF aguardando a aprovação do
 * Financeiro (só membro do Financeiro). Libera a selagem retida.
 */
export const approveFinanceAccountRoute = financeProcedure
  .input(ZApproveFinanceAccountRequestSchema)
  .output(ZApproveFinanceAccountResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId, envelopeItemId, code } = input;

    await assertInvoiceInUserScope({ envelopeId, userId: ctx.user.id });

    return await approveInvoiceAccount({
      envelopeId,
      envelopeItemId,
      code,
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
      requestMetadata: ctx.metadata,
    });
  });
