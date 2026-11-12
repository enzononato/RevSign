// REVALLE: integração com o Patrimônio. GET devolve o estado de um termo. Contrato: revalle/docs/patrimonio.md.
import {
  handlePatrimonioRequest,
  patrimonioJson,
  patrimonioMethodNotAllowed,
} from '@documenso/lib/server-only/revalle/patrimonio/http';
import { getPatrimonioTermo } from '@documenso/lib/server-only/revalle/patrimonio/termos';

import type { Route } from './+types/revalle.patrimonio.v1.termos.$termoId._index';

const ROUTE = 'termo';

export async function loader({ request, params }: Route.LoaderArgs) {
  return await handlePatrimonioRequest(request, ROUTE, async () =>
    patrimonioJson(await getPatrimonioTermo(params.termoId)),
  );
}

export async function action({ request }: Route.ActionArgs) {
  return await patrimonioMethodNotAllowed(request, ROUTE);
}
