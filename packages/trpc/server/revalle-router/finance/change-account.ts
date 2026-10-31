import { changeInvoiceAccount } from '@documenso/lib/server-only/revalle/finance/change-account';

import { ZChangeFinanceAccountRequestSchema, ZChangeFinanceAccountResponseSchema } from './change-account.types';
import { financeProcedure } from './finance-procedure';

/** "Trocar conta" (só membro do Financeiro): a NF ganha uma nova versão com a conta nova, que todos assinam de novo. */
export const changeFinanceAccountRoute = financeProcedure
  .input(ZChangeFinanceAccountRequestSchema)
  .output(ZChangeFinanceAccountResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId, code, reason } = input;

    return await changeInvoiceAccount({
      envelopeId,
      code,
      reason,
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
      requestMetadata: ctx.metadata,
    });
  });
