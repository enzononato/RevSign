import { prisma } from '@documenso/prisma';
import { Prisma } from '@prisma/client';

import { maskCpf } from '../../../revalle/cpf';
import { normalizeEmail } from '../../../revalle/email-domain';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { getColaboradoresRepository } from '../colaboradores/repository';
import { applyRevalleHrName, applyRevalleHrNameByCpf } from '../recipients/apply-hr-name';
import { ensureRevalleGate, getRevalleGateState, logRevalleBaseUnavailable } from './get-gate-state';
import { getRevalleIdentityPolicy } from './identity-policy';
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
    select: { id: true, email: true, name: true, envelopeId: true, role: true, signingStatus: true },
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

  // E-mail de fora da empresa e termo do Patrimônio: confirma sem criar o vínculo e-mail ↔ CPF (o e-mail nunca vira
  // credencial para outros documentos) e sem comparar com o e-mail da base. O CPF fica na linha do portão, para a prova.
  // No termo, só o CPF que o Patrimônio informou.
  const policy = await getRevalleIdentityPolicy(recipient);

  if (policy.mode === 'ALWAYS_CPF') {
    if (policy.expectedCpf !== null && cpf !== policy.expectedCpf) {
      await prisma.revalleRecipientGate.updateMany({
        where: { recipientId, identityStatus: 'VERIFIED', lockedAt: null },
        data: { identityStatus: 'PENDING', pendingCpf: null },
      });

      return await getRevalleGateState(recipient, requestMetadata);
    }

    const alwaysCpfConfirmed = await prisma.$transaction(async (tx) => {
      const confirmed = await tx.revalleRecipientGate.updateMany({
        where: { recipientId, identityStatus: 'VERIFIED', lockedAt: null, pendingCpf: cpf },
        data: { identityStatus: 'CONFIRMED', cpf, pendingCpf: null, identityConfirmedAt: new Date() },
      });

      if (confirmed.count === 0) {
        return false;
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

      return true;
    });

    // Identidade conferida: o nome passa a ser o do RH (aqui a base ainda não foi consultada na confirmação).
    if (alwaysCpfConfirmed) {
      await applyRevalleHrNameByCpf({ recipientId, cpf, requestMetadata });
    }

    return await getRevalleGateState(recipient, requestMetadata);
  }

  const repository = getColaboradoresRepository();

  if (!repository) {
    logRevalleBaseUnavailable();

    return { status: 'UNAVAILABLE' };
  }

  let baseEmail: string | null;
  let hrName: string | null;

  try {
    const colaborador = await repository.findByCpf(cpf);

    baseEmail = colaborador?.email ?? null;
    hrName = colaborador?.nome ?? null;
  } catch (error) {
    logRevalleBaseUnavailable(error);

    return { status: 'UNAVAILABLE' };
  }

  let committed = false;

  const commit = async () => {
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

    committed = true;
  };

  const isUniqueViolation = (error: unknown) =>
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

  try {
    try {
      await commit();
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      // Confirmação concorrente do mesmo e-mail e CPF não é conflito: na segunda passada o vínculo já existe e confere.
      await commit();
    }
  } catch (error) {
    if (error instanceof ConflictError || isUniqueViolation(error)) {
      await lockRevalleGate({ recipientId, reason: 'CPF_CONFLICT', conflictCpf: cpf, requestMetadata });

      return { status: 'LOCKED' };
    }

    if (!(error instanceof NotVerifiedError)) {
      throw error;
    }
  }

  // Identidade conferida: o nome passa a ser o do RH.
  if (committed) {
    await applyRevalleHrName({ recipientId, hrName, requestMetadata });
  }

  return await getRevalleGateState(recipient, requestMetadata);
};
