import { prisma } from '@documenso/prisma';

import { maskCpf } from '../../../revalle/cpf';
import { normalizeEmail } from '../../../revalle/email-domain';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { ensureRevalleGate, getRevalleGateState } from './get-gate-state';
import type { RevalleGateState } from './types';

export const confirmRevalleIdentity = async ({
  recipientId,
  isMe,
  requestMetadata,
}: {
  recipientId: number;
  isMe: boolean;
  requestMetadata: RequestMetadata;
}): Promise<RevalleGateState> => {
  const recipient = await prisma.recipient.findUniqueOrThrow({
    where: { id: recipientId },
    select: { id: true, email: true, name: true, envelopeId: true },
  });

  const gate = await ensureRevalleGate(recipientId);

  if (!gate.lockedAt && gate.identityStatus === 'VERIFIED' && gate.pendingCpf) {
    if (isMe) {
      const cpf = gate.pendingCpf;
      const email = normalizeEmail(recipient.email);

      await prisma.$transaction(async (tx) => {
        const confirmed = await tx.revalleRecipientGate.updateMany({
          where: { recipientId, lockedAt: null, identityStatus: 'VERIFIED' },
          data: { identityStatus: 'CONFIRMED', cpf, pendingCpf: null, identityConfirmedAt: new Date() },
        });

        if (confirmed.count === 0) {
          return;
        }

        await tx.revalleEmailLink.upsert({
          where: { email },
          create: { email, cpf, createdByRecipientId: recipientId },
          update: {},
        });

        await tx.documentAuditLog.create({
          data: createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_IDENTITY_CONFIRMED,
            envelopeId: recipient.envelopeId,
            data: { cpfMasked: maskCpf(cpf) },
            user: { name: recipient.name, email: recipient.email },
            requestMetadata,
          }),
        });
      });
    } else {
      await prisma.revalleRecipientGate.updateMany({
        where: { recipientId, identityStatus: 'VERIFIED' },
        data: { identityStatus: 'PENDING', pendingCpf: null },
      });
    }
  }

  return await getRevalleGateState(recipient, requestMetadata);
};
