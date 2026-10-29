import { prisma } from '@documenso/prisma';
import type { RevalleRecipientGate } from '@prisma/client';

import { maskCpf } from '../../../revalle/cpf';
import { normalizeEmail } from '../../../revalle/email-domain';
import { REVALLE_TERM_NOTICE, REVALLE_TERM_TEXT, REVALLE_TERM_VERSION } from '../../../revalle/term';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { env } from '../../../utils/env';
import { logger } from '../../../utils/logger';
import type { Colaborador } from '../colaboradores/repository';
import { getColaboradoresRepository } from '../colaboradores/repository';
import { REVALLE_MAX_ATTEMPTS, type RevalleGateRecipient, type RevalleGateState } from './types';

export const isRevalleIdentityCheckDisabled = () => env('NEXT_PRIVATE_REVALLE_IDENTITY_CHECK') === 'disabled';

export const logRevalleBaseUnavailable = () => {
  logger.error({ msg: '[RevSign] base de colaboradores indisponível' });
};

export const ensureRevalleGate = async (recipientId: number): Promise<RevalleRecipientGate> => {
  const existing = await prisma.revalleRecipientGate.findUnique({ where: { recipientId } });

  if (existing) {
    return existing;
  }

  try {
    return await prisma.revalleRecipientGate.create({ data: { recipientId } });
  } catch {
    return await prisma.revalleRecipientGate.findUniqueOrThrow({ where: { recipientId } });
  }
};

export const previewOf = (colaborador: Colaborador): RevalleGateState => ({
  status: 'IDENTITY_CONFIRM',
  preview: {
    primeiroNome: colaborador.nome.trim().split(/\s+/)[0] ?? '',
    cargo: colaborador.cargo,
    unidade: colaborador.unidade,
  },
});

const markLinked = async (
  recipient: RevalleGateRecipient,
  cpf: string,
  requestMetadata: RequestMetadata | undefined,
) => {
  const updated = await prisma.revalleRecipientGate.updateMany({
    where: { recipientId: recipient.id, identityStatus: { notIn: ['LINKED', 'CONFIRMED', 'SKIPPED'] } },
    data: { identityStatus: 'LINKED', cpf, identityConfirmedAt: new Date() },
  });

  if (updated.count === 0) {
    return;
  }

  const row = await prisma.recipient.findUnique({
    where: { id: recipient.id },
    select: { envelopeId: true, name: true, email: true },
  });

  if (row) {
    await prisma.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_IDENTITY_LINKED,
        envelopeId: row.envelopeId,
        data: { cpfMasked: maskCpf(cpf) },
        user: { name: row.name, email: row.email },
        requestMetadata,
      }),
    });
  }
};

export const getRevalleGateState = async (
  recipient: RevalleGateRecipient,
  requestMetadata?: RequestMetadata,
): Promise<RevalleGateState> => {
  const gate = await ensureRevalleGate(recipient.id);

  if (gate.lockedAt) {
    return { status: 'LOCKED' };
  }

  if (gate.termVersion !== REVALLE_TERM_VERSION || !gate.termAcceptedAt) {
    return {
      status: 'TERM_REQUIRED',
      termVersion: REVALLE_TERM_VERSION,
      termText: REVALLE_TERM_TEXT,
      termNotice: REVALLE_TERM_NOTICE,
    };
  }

  if (['CONFIRMED', 'LINKED', 'SKIPPED'].includes(gate.identityStatus)) {
    return { status: 'PASSED' };
  }

  if (isRevalleIdentityCheckDisabled()) {
    await prisma.revalleRecipientGate.update({
      where: { recipientId: recipient.id },
      data: { identityStatus: 'SKIPPED' },
    });

    return { status: 'PASSED' };
  }

  const email = normalizeEmail(recipient.email);
  const link = await prisma.revalleEmailLink.findUnique({ where: { email } });

  if (link) {
    await markLinked(recipient, link.cpf, requestMetadata);

    return { status: 'PASSED' };
  }

  const repository = getColaboradoresRepository();

  if (!repository) {
    logRevalleBaseUnavailable();

    return { status: 'UNAVAILABLE' };
  }

  try {
    const byEmail = await repository.findByEmail(email);

    if (byEmail) {
      await markLinked(recipient, byEmail.cpf, requestMetadata);

      return { status: 'PASSED' };
    }

    if (gate.identityStatus === 'VERIFIED' && gate.pendingCpf) {
      const pending = await repository.findByCpf(gate.pendingCpf);

      if (pending) {
        return previewOf(pending);
      }
    }
  } catch {
    logRevalleBaseUnavailable();

    return { status: 'UNAVAILABLE' };
  }

  return { status: 'IDENTITY_REQUIRED', attemptsLeft: Math.max(0, REVALLE_MAX_ATTEMPTS - gate.failedAttempts) };
};
