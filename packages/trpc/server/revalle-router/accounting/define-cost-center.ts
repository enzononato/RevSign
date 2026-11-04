import { defineInvoiceCostCenter } from '@documenso/lib/server-only/revalle/accounting/validate-cost-center';

import { accountingProcedure } from './accounting-procedure';
import { ZDefineCostCenterRequestSchema, ZDefineCostCenterResponseSchema } from './define-cost-center.types';

/** "Definir centro de custo" (só membro da Contabilidade): NF enviada sem centro; grava e valida, sem nova versão. */
export const defineCostCenterRoute = accountingProcedure
  .input(ZDefineCostCenterRequestSchema)
  .output(ZDefineCostCenterResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId, code } = input;

    await defineInvoiceCostCenter({
      envelopeId,
      code,
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
      requestMetadata: ctx.metadata,
    });
  });
