import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { sendReceiptFileName } from '@documenso/lib/revalle/receipts/send-receipt';
import { getReceiptEnvelopeForUser } from '@documenso/lib/server-only/revalle/receipts/receipt-access';
import { renderSendReceiptPdf } from '@documenso/lib/server-only/revalle/receipts/render-send-receipt-pdf';
import { findSendReceipt } from '@documenso/lib/server-only/revalle/receipts/send-status';
import contentDisposition from 'content-disposition';

import type { Route } from './+types/documents.$id.comprovantes.$receiptId';

const notFound = () => new Response('Não encontrado.', { status: 404, headers: { 'Content-Type': 'text/plain' } });

/**
 * REVALLE: PDF do comprovante de envio, montado na hora a partir do evento do histórico. Só quem vê a página do
 * documento (dono, time, admin). Comprovante de outro envelope, documento sem acesso ou inexistente: 404.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  if (!user) {
    return new Response('Entre no RevSign para baixar o comprovante.', {
      status: 401,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const envelope = await getReceiptEnvelopeForUser({
    user,
    teamUrl: params.teamUrl,
    envelopeId: params.id,
  });

  if (!envelope) {
    return notFound();
  }

  const receipt = await findSendReceipt({ envelopeId: envelope.id, receiptId: params.receiptId });

  if (!receipt) {
    return notFound();
  }

  const bytes = await renderSendReceiptPdf({
    data: receipt.data,
    createdAt: receipt.createdAt,
    fallbackEnvelopeTitle: envelope.title,
  });

  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(bytes.length),
      'Content-Disposition': contentDisposition(sendReceiptFileName(receipt.data.receiptId)),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
