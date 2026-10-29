import { prisma } from '@documenso/prisma';

import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { logger } from '../../../utils/logger';
import { notifyRevalleGateLocked } from './notify-gate-locked';

export type RevalleLockReason = 'ATTEMPTS' | 'CPF_CONFLICT';

export const lockRevalleGate = async ({
  recipientId,
  reason,
  requestMetadata,
}: {
  recipientId: number;
  reason: RevalleLockReason;
  requestMetadata: RequestMetadata;
}): Promise<void> => {
  const locked = await prisma.revalleRecipientGate.updateMany({
    where: { recipientId, lockedAt: null },
    data: { lockedAt: new Date(), lockReason: reason, identityStatus: 'PENDING', pendingCpf: null },
  });

  if (locked.count === 0) {
    return;
  }

  const recipient = await prisma.recipient.findUniqueOrThrow({
    where: { id: recipientId },
    select: { envelopeId: true, name: true, email: true },
  });

  await prisma.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_GATE_LOCKED,
      envelopeId: recipient.envelopeId,
      data: { reason },
      user: { name: recipient.name, email: recipient.email },
      requestMetadata,
    }),
  });

  try {
    await notifyRevalleGateLocked({ recipientId, reason });
  } catch (error) {
    logger.error({ msg: '[RevSign] falha ao avisar bloqueio do link', recipientId, error: String(error) });
  }
};
