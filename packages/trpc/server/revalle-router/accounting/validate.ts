import { validateInvoiceCostCenter } from '@documenso/lib/server-only/revalle/accounting/validate-cost-center';
import { assertInvoiceInUserScope } from '@documenso/lib/server-only/revalle/invoice/unit-scope';

import { accountingProcedure } from './accounting-procedure';
import { ZValidateCostCenterRequestSchema, ZValidateCostCenterResponseSchema } from './validate.types';

/** "Validar centro de custo" (só membro da Contabilidade): registra quem e quando, sem segurar a conclusão. */
export const validateCostCenterRoute = accountingProcedure
  .input(ZValidateCostCenterRequestSchema)
  .output(ZValidateCostCenterResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId, envelopeItemId } = input;

    await assertInvoiceInUserScope({ envelopeId, userId: ctx.user.id });

    return await validateInvoiceCostCenter({
      envelopeId,
      envelopeItemId,
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
      requestMetadata: ctx.metadata,
    });
  });
