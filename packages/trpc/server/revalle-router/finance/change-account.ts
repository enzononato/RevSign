import { createInvoiceNewVersion } from '@documenso/lib/server-only/revalle/finance/new-version';
import { assertInvoiceInUserScope } from '@documenso/lib/server-only/revalle/invoice/unit-scope';

import { ZChangeFinanceAccountRequestSchema, ZChangeFinanceAccountResponseSchema } from './change-account.types';
import { financeProcedure } from './finance-procedure';

/** "Trocar conta" (só membro do Financeiro): a NF ganha uma nova versão com a conta nova, que todos assinam de novo. */
export const changeFinanceAccountRoute = financeProcedure
  .input(ZChangeFinanceAccountRequestSchema)
  .output(ZChangeFinanceAccountResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId, envelopeItemId, code, reason } = input;

    await assertInvoiceInUserScope({ envelopeId, userId: ctx.user.id });

    return await createInvoiceNewVersion({
      envelopeId,
      envelopeItemId,
      change: { kind: 'ACCOUNT', code },
      reason,
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
      requestMetadata: ctx.metadata,
    });
  });
