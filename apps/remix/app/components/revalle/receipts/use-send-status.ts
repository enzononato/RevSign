import type { SerializedTimelineStep } from '@documenso/lib/revalle/receipts/recipient-stage';
import { useQuery } from '@tanstack/react-query';

// REVALLE: situação de envio por destinatário e comprovantes, lidos da rota `documents/:id/envios` (mesmo acesso da
// página do documento). As mutações do tRPC invalidam todas as consultas, então a lista atualiza depois de um reenvio.

export type SendStatusRecipient = {
  recipientId: number;
  latestReceiptId: string | null;
  steps: SerializedTimelineStep[];
};

export type SendStatusReceipt = {
  receiptId: string;
  recipientId: number;
  recipientName: string;
  recipientEmail: string;
  isResend: boolean;
  kind: 'SEND' | 'RESEND' | 'REMINDER' | null;
  createdAt: string;
  href: string;
};

export type SendStatusResponse = {
  recipients: SendStatusRecipient[];
  receipts: SendStatusReceipt[];
};

export const sendStatusPath = (teamUrl: string, envelopeId: string) =>
  `/t/${encodeURIComponent(teamUrl)}/documents/${encodeURIComponent(envelopeId)}/envios`;

export const useSendStatus = ({
  teamUrl,
  envelopeId,
  enabled = true,
}: {
  teamUrl: string | undefined;
  envelopeId: string | undefined;
  enabled?: boolean;
}) =>
  useQuery({
    queryKey: ['revalle', 'send-status', teamUrl, envelopeId],
    enabled: Boolean(enabled && teamUrl && envelopeId),
    queryFn: async (): Promise<SendStatusResponse> => {
      const response = await fetch(sendStatusPath(teamUrl ?? '', envelopeId ?? ''), {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });

      if (!response.ok) {
        throw new Error(`send-status ${response.status}`);
      }

      return (await response.json()) as SendStatusResponse;
    },
  });
