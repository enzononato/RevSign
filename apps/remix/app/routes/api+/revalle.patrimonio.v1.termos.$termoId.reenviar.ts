// REVALLE: integração com o Patrimônio. POST reenvia o e-mail com o link ao signatário (no máximo 1 vez a cada
// 10 minutos por termo). Contrato: revalle/docs/patrimonio.md.
import {
  handlePatrimonioRequest,
  patrimonioJson,
  patrimonioMethodNotAllowed,
} from '@documenso/lib/server-only/revalle/patrimonio/http';
import { resendPatrimonioTermo } from '@documenso/lib/server-only/revalle/patrimonio/termos';

import type { Route } from './+types/revalle.patrimonio.v1.termos.$termoId.reenviar';

const ROUTE = 'termo-reenviar';

export async function loader({ request }: Route.LoaderArgs) {
  return await patrimonioMethodNotAllowed(request, ROUTE);
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return await patrimonioMethodNotAllowed(request, ROUTE);
  }

  return await handlePatrimonioRequest(request, ROUTE, async ({ sender, requestMetadata }) =>
    patrimonioJson(await resendPatrimonioTermo({ sender, termoId: params.termoId, requestMetadata })),
  );
}
