// REVALLE: integração com o Patrimônio. GET baixa o PDF final selado (só termo SIGNED). Contrato: revalle/docs/patrimonio.md.
import {
  handlePatrimonioRequest,
  patrimonioMethodNotAllowed,
} from '@documenso/lib/server-only/revalle/patrimonio/http';
import { getPatrimonioSignedPdf } from '@documenso/lib/server-only/revalle/patrimonio/termos';

import type { Route } from './+types/revalle.patrimonio.v1.termos.$termoId.pdf';

const ROUTE = 'termo-pdf';

export async function loader({ request, params }: Route.LoaderArgs) {
  return await handlePatrimonioRequest(request, ROUTE, async () => {
    const { bytes, sha256, filename } = await getPatrimonioSignedPdf(params.termoId);

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-RevSign-SHA256': sha256,
      },
    });
  });
}

export async function action({ request }: Route.ActionArgs) {
  return await patrimonioMethodNotAllowed(request, ROUTE);
}
