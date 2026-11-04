import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getInvoiceViewFile } from '@documenso/lib/server-only/revalle/finance/invoice-view';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import contentDisposition from 'content-disposition'; // REVALLE:

import type { Route } from './+types/notas-fiscais.$envelopeId.pdf.$itemId';

const downloadName = (title: string, isCompleted: boolean) =>
  `${title.replace(/\.pdf$/i, '')}${isCompleted ? '_signed' : ''}.pdf`;

const notFound = () => new Response('Não encontrado.', { status: 404, headers: { 'Content-Type': 'text/plain' } });

/**
 * PDF da prévia na página da NF (só leitura), com o mesmo acesso da página: o Financeiro, a Contabilidade e quem está na
 * NF. A rota de arquivos do upstream só libera para o time do documento, e o Financeiro e a Contabilidade não são do time.
 * Com `?download=1`, o mesmo arquivo sai como anexo (botão "Baixar PDF"), com o nome do arquivo e `_signed` quando concluído.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  if (!user) {
    return new Response('Entre no RevSign para ver a nota fiscal.', { status: 401 });
  }

  const file = await getInvoiceViewFile({
    envelopeId: params.envelopeId,
    itemId: params.itemId,
    userId: user.id,
  }).catch((err) => {
    if (AppError.parseError(err).code === AppErrorCode.NOT_FOUND) {
      return null;
    }

    throw err;
  });

  if (!file) {
    return notFound();
  }

  const body = await getFileServerSide(file.documentData);
  const isDownload = new URL(request.url).searchParams.get('download') === '1';

  return new Response(body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
      ...(isDownload ? { 'Content-Disposition': contentDisposition(downloadName(file.title, file.isCompleted)) } : {}),
    },
  });
}
