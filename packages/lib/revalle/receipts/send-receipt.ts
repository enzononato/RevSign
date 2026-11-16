import { DateTime } from 'luxon';

import type { TRevalleSendReceiptData } from '../../types/document-audit-logs';
import { REVALLE_APP_NAME, REVALLE_COMPANY_FOOTER } from '../brand';
import { REVALLE_TIME_ZONE } from '../date-format';

// REVALLE: comprovante de envio. Partes puras (sem banco nem PDF): o conteúdo do evento, o caminho do PDF e as linhas
// do PDF. O PDF sai sempre igual para o mesmo evento: tudo vem do `data` gravado e do `createdAt` do evento.

export type SendReceiptKind = NonNullable<TRevalleSendReceiptData['kind']>;

export type SendReceiptDocument = { title: string; sha256: string };

export type BuildSendReceiptDataOptions = {
  receiptId: string;
  recipient: { id: number; name: string; email: string; role: string };
  kind: SendReceiptKind;
  envelopeTitle: string;
  documents: SendReceiptDocument[];
};

/** O `data` do evento REVALLE_SEND_RECEIPT. Só nome, e-mail e papel do destinatário: nunca CPF nem token. */
export const buildSendReceiptData = ({
  receiptId,
  recipient,
  kind,
  envelopeTitle,
  documents,
}: BuildSendReceiptDataOptions): TRevalleSendReceiptData => ({
  receiptId,
  recipientId: recipient.id,
  recipientName: recipient.name,
  recipientEmail: recipient.email,
  recipientRole: recipient.role,
  channel: 'EMAIL',
  isResend: kind !== 'SEND',
  kind,
  envelopeTitle,
  documents: documents.map(({ title, sha256 }) => ({ title, sha256 })),
});

/** Link do PDF do comprovante (rota de recurso do time; só quem vê a página do documento baixa). */
export const sendReceiptPath = ({
  teamUrl,
  envelopeId,
  receiptId,
}: {
  teamUrl: string;
  envelopeId: string;
  receiptId: string;
}) =>
  `/t/${encodeURIComponent(teamUrl)}/documents/${encodeURIComponent(envelopeId)}/comprovantes/${encodeURIComponent(receiptId)}`;

/** Nome do arquivo baixado. */
export const sendReceiptFileName = (receiptId: string) => `comprovante-de-envio-${receiptId}.pdf`;

/** dd/MM/yyyy HH:mm:ss no horário de Brasília (America/Bahia), independente do fuso do processo. */
export const formatReceiptDateTime = (date: Date) =>
  DateTime.fromJSDate(date).setZone(REVALLE_TIME_ZONE).toFormat('dd/MM/yyyy HH:mm:ss');

const ROLE_LABELS: Record<string, string> = {
  SIGNER: 'Signatário (assinar)',
  APPROVER: 'Aprovador (aprovar)',
  VIEWER: 'Visualizador (visualizar)',
  ASSISTANT: 'Assistente (preencher)',
  CC: 'Cópia',
};

export const sendReceiptRoleLabel = (role: string) => ROLE_LABELS[role] ?? role;

export const sendReceiptKindLabel = (data: Pick<TRevalleSendReceiptData, 'kind' | 'isResend'>) => {
  if (data.kind === 'REMINDER') {
    return 'Lembrete automático (reenvio)';
  }

  return data.isResend ? 'Reenvio' : 'Primeiro envio';
};

/** Uma linha do histórico: "Comprovante de envio — Fulano (e-mail) — dd/mm/aaaa hh:mm". */
export const formatSendReceiptHistoryLine = (
  data: Pick<TRevalleSendReceiptData, 'recipientName' | 'recipientEmail' | 'isResend'>,
  createdAt: Date,
) => {
  const who = data.recipientName ? `${data.recipientName} (${data.recipientEmail})` : data.recipientEmail;
  const when = DateTime.fromJSDate(createdAt).setZone(REVALLE_TIME_ZONE).toFormat('dd/MM/yyyy HH:mm');

  return `Comprovante de envio${data.isResend ? ' (reenvio)' : ''} — ${who} — ${when}`;
};

export type SendReceiptLine =
  | { kind: 'brand'; text: string }
  | { kind: 'title'; text: string }
  | { kind: 'intro'; text: string }
  | { kind: 'section'; text: string }
  | { kind: 'field'; label: string; value: string; small?: boolean }
  | { kind: 'spacer' }
  | { kind: 'footer'; text: string };

/**
 * O conteúdo do PDF, de cima para baixo. Determinístico: só depende do evento (o `data` gravado e o `createdAt`).
 * `envelopeTitle` vem do evento; nos eventos sem ele, o título atual do envelope entra como reserva.
 */
export const buildSendReceiptLines = ({
  data,
  createdAt,
  fallbackEnvelopeTitle,
}: {
  data: TRevalleSendReceiptData;
  createdAt: Date;
  fallbackEnvelopeTitle: string;
}): SendReceiptLine[] => {
  const lines: SendReceiptLine[] = [
    { kind: 'brand', text: REVALLE_APP_NAME },
    { kind: 'title', text: 'Comprovante de envio' },
    {
      kind: 'intro',
      text: `O ${REVALLE_APP_NAME} entregou ao servidor de e-mail a mensagem com o link do documento para o destinatário abaixo.`,
    },
    { kind: 'spacer' },
    { kind: 'section', text: 'Envelope' },
    { kind: 'field', label: 'Título', value: data.envelopeTitle ?? fallbackEnvelopeTitle },
    { kind: 'spacer' },
    { kind: 'section', text: data.documents.length > 1 ? 'Documentos' : 'Documento' },
  ];

  data.documents.forEach((document, index) => {
    lines.push({
      kind: 'field',
      label: data.documents.length > 1 ? `${index + 1}.` : 'Arquivo',
      value: document.title,
    });
    lines.push({ kind: 'field', label: 'SHA-256', value: document.sha256, small: true });
  });

  lines.push(
    { kind: 'spacer' },
    { kind: 'section', text: 'Destinatário' },
    { kind: 'field', label: 'Nome', value: data.recipientName || '-' },
    { kind: 'field', label: 'E-mail', value: data.recipientEmail },
    { kind: 'field', label: 'Papel', value: sendReceiptRoleLabel(data.recipientRole) },
    { kind: 'spacer' },
    { kind: 'section', text: 'Envio' },
    { kind: 'field', label: 'Canal', value: 'E-mail' },
    { kind: 'field', label: 'Tipo', value: sendReceiptKindLabel(data) },
    { kind: 'field', label: 'Data e hora', value: `${formatReceiptDateTime(createdAt)} (horário de Brasília)` },
    { kind: 'field', label: 'Data e hora (UTC)', value: createdAt.toISOString() },
    { kind: 'field', label: 'Comprovante nº', value: data.receiptId },
    { kind: 'spacer' },
    {
      kind: 'footer',
      text: `Gerado pelo ${REVALLE_APP_NAME} a partir do histórico do documento. O SHA-256 identifica o arquivo original enviado, antes das assinaturas.`,
    },
    { kind: 'footer', text: REVALLE_COMPANY_FOOTER },
  );

  return lines;
};
