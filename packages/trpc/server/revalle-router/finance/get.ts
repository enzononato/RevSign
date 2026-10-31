import { getFinanceCard } from '@documenso/lib/server-only/revalle/finance/card';

import { financeProcedure } from './finance-procedure';
import { ZGetFinanceCardRequestSchema, ZGetFinanceCardResponseSchema } from './get.types';

/** Cartão "Financeiro" da página da NF (só membro do Financeiro): conta, quem escolheu, sugestão da IA e estado. */
export const getFinanceCardRoute = financeProcedure
  .input(ZGetFinanceCardRequestSchema)
  .output(ZGetFinanceCardResponseSchema)
  .query(async ({ input }) => await getFinanceCard(input.envelopeId));
