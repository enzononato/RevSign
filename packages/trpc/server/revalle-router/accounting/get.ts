import { getAccountingCard } from '@documenso/lib/server-only/revalle/accounting/card';

import { accountingProcedure } from './accounting-procedure';
import { ZGetAccountingCardRequestSchema, ZGetAccountingCardResponseSchema } from './get.types';

/** Cartão "Contabilidade" da página da NF (só membro da Contabilidade): o centro, a validação e as versões. */
export const getAccountingCardRoute = accountingProcedure
  .input(ZGetAccountingCardRequestSchema)
  .output(ZGetAccountingCardResponseSchema)
  .query(async ({ input }) => await getAccountingCard(input.envelopeId));
