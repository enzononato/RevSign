import { createInvoiceNewVersion } from '@documenso/lib/server-only/revalle/finance/new-version';

import { accountingProcedure } from './accounting-procedure';
import { ZChangeCostCenterRequestSchema, ZChangeCostCenterResponseSchema } from './change-cost-center.types';

/** "Corrigir centro de custo" (só membro da Contabilidade): a NF ganha uma nova versão, que todos assinam de novo. */
export const changeCostCenterRoute = accountingProcedure
  .input(ZChangeCostCenterRequestSchema)
  .output(ZChangeCostCenterResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId, code, reason } = input;

    return await createInvoiceNewVersion({
      envelopeId,
      change: { kind: 'COST_CENTER', code },
      reason,
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
      requestMetadata: ctx.metadata,
    });
  });
