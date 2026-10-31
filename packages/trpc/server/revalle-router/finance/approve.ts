import { approveInvoiceAccount } from '@documenso/lib/server-only/revalle/finance/approve';

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
    const { envelopeId, code } = input;

    return await approveInvoiceAccount({
      envelopeId,
      code,
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
      requestMetadata: ctx.metadata,
    });
  });
