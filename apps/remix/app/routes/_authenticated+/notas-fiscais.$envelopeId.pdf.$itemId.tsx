import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getInvoiceViewFile } from '@documenso/lib/server-only/revalle/finance/invoice-view';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';

import type { Route } from './+types/notas-fiscais.$envelopeId.pdf.$itemId';

const notFound = () => new Response('Não encontrado.', { status: 404, headers: { 'Content-Type': 'text/plain' } });

/**
 * PDF da prévia na página da NF (só leitura), com o mesmo acesso da página: o Financeiro e quem está na NF. A rota de
 * arquivos do upstream só libera para o time do documento, e o Financeiro não é do time.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  if (!user) {
    return new Response('Entre no RevSign para ver a nota fiscal.', { status: 401 });
  }

  const documentData = await getInvoiceViewFile({
    envelopeId: params.envelopeId,
    itemId: params.itemId,
    userId: user.id,
  }).catch((err) => {
    if (AppError.parseError(err).code === AppErrorCode.NOT_FOUND) {
      return null;
    }

    throw err;
  });

  if (!documentData) {
    return notFound();
  }

  const file = await getFileServerSide(documentData);

  return new Response(file, {
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
    },
  });
}
