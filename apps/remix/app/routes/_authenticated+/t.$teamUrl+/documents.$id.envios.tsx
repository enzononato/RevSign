import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { sendReceiptPath } from '@documenso/lib/revalle/receipts/send-receipt';
import { getReceiptEnvelopeForUser } from '@documenso/lib/server-only/revalle/receipts/receipt-access';
import { getEnvelopeSendStatus } from '@documenso/lib/server-only/revalle/receipts/send-status';

import type { Route } from './+types/documents.$id.envios';

/**
 * REVALLE: situação de envio de cada destinatário (Enviado, Visualizado, Assinado/Recusado) e os comprovantes de envio,
 * em JSON, para os cartões da página do documento. Mesmo acesso da página (e do PDF do comprovante).
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  if (!user) {
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  const envelope = await getReceiptEnvelopeForUser({
    user,
    teamUrl: params.teamUrl,
    envelopeId: params.id,
  });

  if (!envelope) {
    return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  const status = await getEnvelopeSendStatus(envelope.id);

  return Response.json(
    {
      recipients: status.recipients,
      receipts: status.receipts.map((receipt) => ({
        receiptId: receipt.receiptId,
        recipientId: receipt.recipientId,
        recipientName: receipt.recipientName,
        recipientEmail: receipt.recipientEmail,
        isResend: receipt.isResend,
        kind: receipt.kind ?? null,
        createdAt: receipt.createdAt.toISOString(),
        href: sendReceiptPath({ teamUrl: envelope.team.url, envelopeId: envelope.id, receiptId: receipt.receiptId }),
      })),
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
