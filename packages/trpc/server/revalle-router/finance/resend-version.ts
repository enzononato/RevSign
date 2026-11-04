import { isAccountingMember } from '@documenso/lib/server-only/revalle/accounting/members';
import { resendInvoiceVersion } from '@documenso/lib/server-only/revalle/finance/define-and-send';
import { isFinanceMember } from '@documenso/lib/server-only/revalle/finance/members';
import { TRPCError } from '@trpc/server';

import { authenticatedProcedure } from '../../trpc';
import { ZResendFinanceVersionRequestSchema, ZResendFinanceVersionResponseSchema } from './resend-version.types';

/** A nova versão vem de um dos dois perfis, e os dois podem mandá-la de novo: sem sessão 401, fora dos dois 403. */
const financeOrAccountingProcedure = authenticatedProcedure.use(async ({ ctx, next }) => {
  const [isFinance, isAccounting] = await Promise.all([isFinanceMember(ctx.user.id), isAccountingMember(ctx.user.id)]);

  if (!isFinance && !isAccounting) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Só quem é do Financeiro ou da Contabilidade pode fazer isso.' });
  }

  return await next();
});

/** "Enviar de novo": a nova versão que ficou em rascunho porque o envio dela falhou. */
export const resendFinanceVersionRoute = financeOrAccountingProcedure
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
