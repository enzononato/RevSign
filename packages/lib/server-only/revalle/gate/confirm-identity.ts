import { prisma } from '@documenso/prisma';
import { Prisma } from '@prisma/client';

import { maskCpf } from '../../../revalle/cpf';
import { normalizeEmail } from '../../../revalle/email-domain';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { getColaboradoresRepository } from '../colaboradores/repository';
import { ensureRevalleGate, getRevalleGateState, logRevalleBaseUnavailable } from './get-gate-state';
import { lockRevalleGate } from './lock-gate';
import type { RevalleGateState } from './types';

class ConflictError extends Error {}
class NotVerifiedError extends Error {}

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

  const gate = await ensureRevalleGate(recipient);

  if (gate.lockedAt || gate.identityStatus !== 'VERIFIED' || !gate.pendingCpf) {
    return await getRevalleGateState(recipient, requestMetadata);
  }

  if (!isMe) {
    await prisma.revalleRecipientGate.updateMany({
      where: { recipientId, identityStatus: 'VERIFIED', lockedAt: null },
      data: { identityStatus: 'PENDING', pendingCpf: null },
    });

    return await getRevalleGateState(recipient, requestMetadata);
  }

  const cpf = gate.pendingCpf;
  const email = normalizeEmail(recipient.email);

  const repository = getColaboradoresRepository();

  if (!repository) {
    logRevalleBaseUnavailable();

    return { status: 'UNAVAILABLE' };
  }

  let baseEmail: string | null;

  try {
    baseEmail = (await repository.findByCpf(cpf))?.email ?? null;
  } catch (error) {
    logRevalleBaseUnavailable(error);

    return { status: 'UNAVAILABLE' };
  }

  try {
    if (baseEmail && normalizeEmail(baseEmail) !== email) {
      throw new ConflictError();
    }

    await prisma.$transaction(async (tx) => {
      const confirmed = await tx.revalleRecipientGate.updateMany({
        where: { recipientId, identityStatus: 'VERIFIED', lockedAt: null, pendingCpf: cpf },
        data: { identityStatus: 'CONFIRMED', cpf, pendingCpf: null, identityConfirmedAt: new Date() },
      });

      if (confirmed.count === 0) {
        throw new NotVerifiedError();
      }

      const existing = await tx.revalleEmailLink.findFirst({ where: { OR: [{ email }, { cpf }] } });

      if (existing && (existing.email !== email || existing.cpf !== cpf)) {
        throw new ConflictError();
      }

      if (!existing) {
        await tx.revalleEmailLink.create({ data: { email, cpf, createdByRecipientId: recipientId } });
      }

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
  } catch (error) {
    const isUniqueViolation = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

    if (error instanceof ConflictError || isUniqueViolation) {
      await lockRevalleGate({ recipientId, reason: 'CPF_CONFLICT', requestMetadata });

      return { status: 'LOCKED' };
    }

    if (!(error instanceof NotVerifiedError)) {
      throw error;
    }
  }

  return await getRevalleGateState(recipient, requestMetadata);
};
