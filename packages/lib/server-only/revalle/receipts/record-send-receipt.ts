import { prisma } from '@documenso/prisma';
import {
  buildSendReceiptData,
  type SendReceiptDocument,
  type SendReceiptKind,
} from '../../../revalle/receipts/send-receipt';
import { sha256Hex } from '../../../revalle/sha256';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { ApiRequestMetadata, RequestMetadata } from '../../../universal/extract-request-metadata';
import { alphaid } from '../../../universal/id';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { logger } from '../../../utils/logger';

// REVALLE: comprovante de envio. Gravado DEPOIS que o servidor de e-mail aceitou a mensagem com o link de assinatura.

/** Título e SHA-256 do arquivo ORIGINAL (`initialData`) de cada item do envelope, na ordem do envelope. */
export const computeReceiptDocuments = async (envelopeId: string): Promise<SendReceiptDocument[]> => {
  const items = await prisma.envelopeItem.findMany({
    where: { envelopeId },
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
    select: { title: true, documentData: { select: { type: true, initialData: true } } },
  });

  return await Promise.all(
    items.map(async (item) => ({
      title: item.title,
      sha256: sha256Hex(await getFileServerSide({ type: item.documentData.type, data: item.documentData.initialData })),
    })),
  );
};

export type RecordSendReceiptOptions = {
  envelopeId: string;
  recipient: { id: number; name: string; email: string; role: string };
  /**
   * `SEND`: convite do job de envio (vira `RESEND` sozinho se a pessoa já tinha comprovante); `RESEND`: reenvio manual;
   * `REMINDER`: lembrete automático.
   */
  kind: SendReceiptKind;
  /** Quem enviou (o evento fica com o nome/e-mail dele, como o EMAIL_SENT). Nulo no lembrete automático. */
  user?: { id?: number | null; name?: string | null; email?: string | null } | null;
  requestMetadata?: RequestMetadata;
  metadata?: ApiRequestMetadata;
  /** Já calculados (reenvio para várias pessoas): evita baixar os arquivos de novo. */
  documents?: SendReceiptDocument[];
};

export const recordSendReceipt = async ({
  envelopeId,
  recipient,
  kind,
  user,
  requestMetadata,
  metadata,
  documents,
}: RecordSendReceiptOptions) => {
  const [envelope, previous, receiptDocuments] = await Promise.all([
    prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId }, select: { title: true } }),
    kind === 'SEND'
      ? prisma.documentAuditLog.findFirst({
          where: {
            envelopeId,
            type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_SEND_RECEIPT,
            data: { path: ['recipientId'], equals: recipient.id },
          },
          select: { id: true },
        })
      : Promise.resolve(null),
    documents ? Promise.resolve(documents) : computeReceiptDocuments(envelopeId),
  ]);

  const data = buildSendReceiptData({
    receiptId: alphaid(),
    recipient,
    kind: kind === 'SEND' && previous ? 'RESEND' : kind,
    envelopeTitle: envelope.title,
    documents: receiptDocuments,
  });

  return await prisma.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_SEND_RECEIPT,
      envelopeId,
      user: user ?? undefined,
      requestMetadata,
      metadata,
      data,
    }),
  });
};

/**
 * Para os caminhos em que o e-mail já saiu e um erro aqui não pode virar "falha no envio" (reenvio, lembrete): registra
 * no log (sem dados do documento nem do destinatário além dos ids) e segue.
 */
export const recordSendReceiptSafely = async (options: RecordSendReceiptOptions) => {
  try {
    await recordSendReceipt(options);
  } catch (err) {
    logger.error({
      msg: 'revalle: falha ao gravar o comprovante de envio',
      envelopeId: options.envelopeId,
      recipientId: options.recipient.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
