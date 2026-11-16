import { prisma } from '@documenso/prisma';

import {
  buildRecipientTimeline,
  collectRecipientSendEvents,
  OPEN_EVIDENCE_TYPES,
  type SerializedTimelineStep,
  serializeTimeline,
} from '../../../revalle/receipts/recipient-stage';
import {
  DOCUMENT_AUDIT_LOG_TYPE,
  type TRevalleSendReceiptData,
  ZRevalleSendReceiptDataSchema,
} from '../../../types/document-audit-logs';

// REVALLE: a situação de envio de cada destinatário e os comprovantes de um envelope. Quem chama já conferiu o acesso.

const SEND_EVENT_TYPES: string[] = [
  DOCUMENT_AUDIT_LOG_TYPE.REVALLE_SEND_RECEIPT,
  DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
  DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_REJECTED,
  ...OPEN_EVIDENCE_TYPES,
];

export type SendReceiptSummary = {
  /** id do evento no histórico. */
  auditLogId: string;
  receiptId: string;
  recipientId: number;
  recipientName: string;
  recipientEmail: string;
  isResend: boolean;
  kind: TRevalleSendReceiptData['kind'];
  createdAt: Date;
};

export type RecipientSendStatus = {
  recipientId: number;
  latestReceiptId: string | null;
  steps: SerializedTimelineStep[];
};

export type EnvelopeSendStatus = {
  recipients: RecipientSendStatus[];
  /** Do mais novo para o mais antigo. */
  receipts: SendReceiptSummary[];
};

export const getEnvelopeSendStatus = async (envelopeId: string): Promise<EnvelopeSendStatus> => {
  const [recipients, logs] = await Promise.all([
    prisma.recipient.findMany({
      where: { envelopeId },
      select: {
        id: true,
        email: true,
        role: true,
        sendStatus: true,
        readStatus: true,
        signingStatus: true,
        signedAt: true,
      },
    }),
    prisma.documentAuditLog.findMany({
      where: { envelopeId, type: { in: SEND_EVENT_TYPES } },
      select: { id: true, type: true, createdAt: true, data: true, email: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const events = collectRecipientSendEvents(logs, recipients);

  const receipts: SendReceiptSummary[] = [];

  for (const log of logs) {
    if (log.type !== DOCUMENT_AUDIT_LOG_TYPE.REVALLE_SEND_RECEIPT) {
      continue;
    }

    const parsed = ZRevalleSendReceiptDataSchema.safeParse(log.data);

    if (!parsed.success) {
      continue;
    }

    receipts.push({
      auditLogId: log.id,
      receiptId: parsed.data.receiptId,
      recipientId: parsed.data.recipientId,
      recipientName: parsed.data.recipientName,
      recipientEmail: parsed.data.recipientEmail,
      isResend: parsed.data.isResend,
      kind: parsed.data.kind,
      createdAt: log.createdAt,
    });
  }

  receipts.reverse();

  return {
    recipients: recipients.map((recipient) => ({
      recipientId: recipient.id,
      latestReceiptId: events.get(recipient.id)?.latestReceiptId ?? null,
      steps: serializeTimeline(buildRecipientTimeline(recipient, events.get(recipient.id))),
    })),
    receipts,
  };
};

/** O comprovante pelo id, só se for deste envelope (senão nulo). */
export const findSendReceipt = async ({ envelopeId, receiptId }: { envelopeId: string; receiptId: string }) => {
  const log = await prisma.documentAuditLog.findFirst({
    where: {
      envelopeId,
      type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_SEND_RECEIPT,
      data: { path: ['receiptId'], equals: receiptId },
    },
    select: { id: true, createdAt: true, data: true },
  });

  if (!log) {
    return null;
  }

  const parsed = ZRevalleSendReceiptDataSchema.safeParse(log.data);

  if (!parsed.success || parsed.data.receiptId !== receiptId) {
    return null;
  }

  return { auditLogId: log.id, createdAt: log.createdAt, data: parsed.data };
};
