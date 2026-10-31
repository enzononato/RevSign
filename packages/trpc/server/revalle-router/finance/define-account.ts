import { defineInvoiceAccountAndSend } from '@documenso/lib/server-only/revalle/finance/define-and-send';

import { ZDefineFinanceAccountRequestSchema, ZDefineFinanceAccountResponseSchema } from './define-account.types';
import { financeProcedure } from './finance-procedure';

/** "Definir conta e enviar": NF retida com "Deixar para o Financeiro" (só membro do Financeiro). */
export const defineFinanceAccountRoute = financeProcedure
  .input(ZDefineFinanceAccountRequestSchema)
  .output(ZDefineFinanceAccountResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId, code } = input;

    return await defineInvoiceAccountAndSend({
      envelopeId,
      code,
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
      requestMetadata: ctx.metadata,
    });
  });
