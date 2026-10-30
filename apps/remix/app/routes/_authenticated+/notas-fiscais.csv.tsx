import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import {
  brasiliaToday,
  INVOICE_EXPORT_LIMIT_MESSAGE,
  parseInvoiceFilterParams,
} from '@documenso/lib/revalle/invoice/invoice-filters';
import { exportInvoicesCsv } from '@documenso/lib/server-only/revalle/invoice/find-invoices';
import { isAdmin } from '@documenso/lib/utils/is-admin';

import type { Route } from './+types/notas-fiscais.csv';

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

/** Planilha da página "Notas fiscais" (mesmos filtros da URL e mesma visibilidade). */
export async function loader({ request }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  // O middleware do layout já manda para o login; isto cobre a rota chamada fora dele.
  if (!user) {
    return text('Entre no RevSign para exportar.', 401);
  }

  const filters = parseInvoiceFilterParams(new URL(request.url).searchParams);

  if (!filters.success) {
    return text('Filtro inválido.', 400);
  }

  const result = await exportInvoicesCsv({ userId: user.id, isAdmin: isAdmin(user), filters: filters.data });

  if (result.tooMany) {
    return text(INVOICE_EXPORT_LIMIT_MESSAGE, 400);
  }

  return new Response(result.csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="notas-fiscais-${brasiliaToday()}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
