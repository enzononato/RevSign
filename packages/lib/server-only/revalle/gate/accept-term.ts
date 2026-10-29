import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { REVALLE_TERM_VERSION } from '../../../revalle/term';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { ensureRevalleGate, getRevalleGateState } from './get-gate-state';
import type { RevalleGateState } from './types';

export const acceptRevalleTerm = async ({
  recipientId,
  termVersion,
  requestMetadata,
}: {
  recipientId: number;
  termVersion: string;
  requestMetadata: RequestMetadata;
}): Promise<RevalleGateState> => {
  if (termVersion !== REVALLE_TERM_VERSION) {
    throw new AppError(AppErrorCode.INVALID_BODY, { message: 'Versão do termo desatualizada. Recarregue a página.' });
  }

  const recipient = await prisma.recipient.findUniqueOrThrow({
    where: { id: recipientId },
    select: { id: true, email: true, name: true, envelopeId: true, role: true, signingStatus: true },
  });

  const gate = await ensureRevalleGate(recipient);

  if (!gate.lockedAt && gate.termVersion !== REVALLE_TERM_VERSION) {
    await prisma.$transaction(async (tx) => {
      await tx.revalleRecipientGate.update({
        where: { recipientId },
        data: {
          termVersion: REVALLE_TERM_VERSION,
          termAcceptedAt: new Date(),
          termIpAddress: requestMetadata.ipAddress ?? null,
          termUserAgent: requestMetadata.userAgent ?? null,
        },
      });

      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_TERM_ACCEPTED,
          envelopeId: recipient.envelopeId,
          data: { termVersion: REVALLE_TERM_VERSION },
          user: { name: recipient.name, email: recipient.email },
          requestMetadata,
        }),
      });
    });
  }

  return await getRevalleGateState(recipient, requestMetadata);
};
