import { prisma } from '@documenso/prisma';
import { EnvelopeType, ReadStatus, SendStatus, WebhookTriggerEvents } from '@prisma/client';

import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../../types/webhook-payload';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { logger } from '../../../utils/logger';
import { triggerWebhook } from '../../webhooks/trigger/trigger-webhook';

/**
 * "Visualizado" = o próprio destinatário abriu o link (16/11/2026). A página de assinatura serve a tela do portão antes
 * do documento e por isso não chama `viewedDocument`; aqui fica registrada a abertura como o upstream faz (uma vez por
 * destinatário: `readStatus` OPENED + evento DOCUMENT_OPENED + webhook), sem o DOCUMENT_VIEWED (o documento ainda não
 * apareceu). Só chamar depois da regra da conta: o pedido redirecionado para Entrar/Criar conta não é o destinatário.
 * Falha aqui nunca derruba a página.
 */
export const recordRevalleLinkOpened = async ({
  token,
  requestMetadata,
}: {
  token: string;
  requestMetadata?: RequestMetadata;
}): Promise<void> => {
  try {
    const recipient = await prisma.recipient.findFirst({
      where: { token, envelope: { type: EnvelopeType.DOCUMENT } },
    });

    if (!recipient || recipient.readStatus === ReadStatus.OPENED) {
      return;
    }

    const opened = await prisma.$transaction(async (tx) => {
      // Só um pedido marca a abertura, mesmo com dois abrindo ao mesmo tempo.
      const updated = await tx.recipient.updateMany({
        where: { id: recipient.id, readStatus: { not: ReadStatus.OPENED } },
        data: {
          sendStatus: SendStatus.SENT,
          readStatus: ReadStatus.OPENED,
          ...(!recipient.sentAt ? { sentAt: new Date() } : {}),
        },
      });

      if (updated.count === 0) {
        return false;
      }

      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_OPENED,
          envelopeId: recipient.envelopeId,
          user: { name: recipient.name, email: recipient.email },
          requestMetadata,
          data: {
            recipientEmail: recipient.email,
            recipientId: recipient.id,
            recipientName: recipient.name,
            recipientRole: recipient.role,
            accessAuth: [],
          },
        }),
      });

      return true;
    });

    if (!opened) {
      return;
    }

    const envelope = await prisma.envelope.findUniqueOrThrow({
      where: { id: recipient.envelopeId },
      include: { documentMeta: true, recipients: true },
    });

    await triggerWebhook({
      event: WebhookTriggerEvents.DOCUMENT_OPENED,
      data: ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(envelope)),
      userId: envelope.userId,
      teamId: envelope.teamId,
    });
  } catch (error) {
    logger.error({ msg: '[RevSign] falha ao registrar a abertura do link', error: String(error) });
  }
};
