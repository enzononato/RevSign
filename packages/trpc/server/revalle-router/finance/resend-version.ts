import { resendInvoiceVersion } from '@documenso/lib/server-only/revalle/finance/define-and-send';

import { financeProcedure } from './finance-procedure';
import { ZResendFinanceVersionRequestSchema, ZResendFinanceVersionResponseSchema } from './resend-version.types';

/** "Enviar de novo": a nova versão de uma troca de conta que ficou em rascunho (só membro do Financeiro). */
export const resendFinanceVersionRoute = financeProcedure
  .input(ZResendFinanceVersionRequestSchema)
  .output(ZResendFinanceVersionResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId } = input;

    return await resendInvoiceVersion({
      envelopeId,
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
      requestMetadata: ctx.metadata,
    });
  });
