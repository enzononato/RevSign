import { approveInvoiceAccount } from '@documenso/lib/server-only/revalle/finance/approve';

import { ZApproveFinanceAccountRequestSchema, ZApproveFinanceAccountResponseSchema } from './approve.types';
import { financeProcedure } from './finance-procedure';

/** "Aprovar conta": NF aguardando a aprovação do Financeiro (só membro do Financeiro). Libera a selagem retida. */
export const approveFinanceAccountRoute = financeProcedure
  .input(ZApproveFinanceAccountRequestSchema)
  .output(ZApproveFinanceAccountResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId } = input;

    return await approveInvoiceAccount({
      envelopeId,
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
      requestMetadata: ctx.metadata,
    });
  });
