// REVALLE: integração com o Patrimônio. POST cria e envia um termo (multipart); GET busca pelo externalId.
// Contrato: revalle/docs/patrimonio.md.

import {
  PATRIMONIO_EXTERNAL_ID_REGEX,
  PatrimonioError,
  parseCreateTermoFields,
} from '@documenso/lib/revalle/patrimonio/request';
import {
  handlePatrimonioRequest,
  patrimonioJson,
  patrimonioMethodNotAllowed,
} from '@documenso/lib/server-only/revalle/patrimonio/http';
import { readTermoMultipart } from '@documenso/lib/server-only/revalle/patrimonio/multipart';
import {
  createPatrimonioTermo,
  findPatrimonioTermosByExternalId,
} from '@documenso/lib/server-only/revalle/patrimonio/termos';

import type { Route } from './+types/revalle.patrimonio.v1.termos._index';

const ROUTE = 'termos';

export async function loader({ request }: Route.LoaderArgs) {
  return await handlePatrimonioRequest(request, ROUTE, async () => {
    const externalId = new URL(request.url).searchParams.get('externalId');

    if (!externalId || !PATRIMONIO_EXTERNAL_ID_REGEX.test(externalId)) {
      throw new PatrimonioError('INVALID_REQUEST', 'Informe o externalId (?externalId=…).');
    }

    return patrimonioJson({ data: await findPatrimonioTermosByExternalId(externalId) });
  });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return await patrimonioMethodNotAllowed(request, ROUTE);
  }

  return await handlePatrimonioRequest(request, ROUTE, async ({ sender, requestMetadata }) => {
    const { fields, file } = await readTermoMultipart(request);
    const termo = await createPatrimonioTermo({
      sender,
      fields: parseCreateTermoFields(fields),
      file,
      requestMetadata,
    });

    return patrimonioJson(termo, 201);
  });
}
