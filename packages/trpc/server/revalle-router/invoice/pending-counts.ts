import { getInvoicePendingCounts } from '@documenso/lib/server-only/revalle/invoice/pending-counts';

import { authenticatedProcedure } from '../../trpc';
import { ZInvoicePendingCountsResponseSchema } from './pending-counts.types';

/** Contador do menu "Notas fiscais": quantas NFs esperam o Financeiro e a Contabilidade (cada uma `null` para quem não é do perfil). */
export const invoicePendingCountsRoute = authenticatedProcedure
  .output(ZInvoicePendingCountsResponseSchema)
  .query(async ({ ctx }) => await getInvoicePendingCounts(ctx.user.id));
