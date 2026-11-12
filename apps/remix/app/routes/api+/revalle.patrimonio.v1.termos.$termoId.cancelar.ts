// REVALLE: integração com o Patrimônio. POST cancela um termo pendente ({ "reason"?: string }).
// Contrato: revalle/docs/patrimonio.md.

import { parseCancelReason } from '@documenso/lib/revalle/patrimonio/request';
import {
  handlePatrimonioRequest,
  patrimonioJson,
  patrimonioMethodNotAllowed,
} from '@documenso/lib/server-only/revalle/patrimonio/http';
import { readOptionalJson } from '@documenso/lib/server-only/revalle/patrimonio/multipart';
import { cancelPatrimonioTermo } from '@documenso/lib/server-only/revalle/patrimonio/termos';

import type { Route } from './+types/revalle.patrimonio.v1.termos.$termoId.cancelar';

const ROUTE = 'termo-cancelar';

export async function loader({ request }: Route.LoaderArgs) {
  return await patrimonioMethodNotAllowed(request, ROUTE);
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return await patrimonioMethodNotAllowed(request, ROUTE);
  }

  return await handlePatrimonioRequest(request, ROUTE, async ({ sender, requestMetadata }) => {
    const reason = parseCancelReason(await readOptionalJson(request));

    return patrimonioJson(await cancelPatrimonioTermo({ sender, termoId: params.termoId, reason, requestMetadata }));
  });
}
