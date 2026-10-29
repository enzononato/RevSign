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

export const logRevalleBaseUnavailable = (error?: unknown) => {
  const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;

  logger.error({ msg: '[RevSign] base de colaboradores indisponível', code });
};

/**
 * Devolve a linha do portão. Se o e-mail do destinatário mudou desde a última vez, o portão volta ao início
 * (termo e identidade; tentativas e bloqueio ficam), para que quem recebe o link depois não herde o que foi feito pelo e-mail anterior.
 */
export const ensureRevalleGate = async (recipient: RevalleGateRecipient): Promise<RevalleRecipientGate> => {
  const email = normalizeEmail(recipient.email);
  const recipientId = recipient.id;
  let gate = await prisma.revalleRecipientGate.findUnique({ where: { recipientId } });

  if (!gate) {
    try {
      gate = await prisma.revalleRecipientGate.create({ data: { recipientId, email } });
    } catch {
      gate = await prisma.revalleRecipientGate.findUniqueOrThrow({ where: { recipientId } });
    }
  }

  if (gate.email === email) {
    return gate;
  }

  if (gate.email === null) {
    await prisma.revalleRecipientGate.updateMany({ where: { recipientId, email: null }, data: { email } });
  } else {
    await prisma.revalleRecipientGate.updateMany({
      where: { recipientId, email: gate.email },
      data: {
        email,
        termVersion: null,
        termAcceptedAt: null,
        termIpAddress: null,
        termUserAgent: null,
        identityStatus: 'PENDING',
        pendingCpf: null,
        cpf: null,
        identityConfirmedAt: null,
      },
    });
  }

  return await prisma.revalleRecipientGate.findUniqueOrThrow({ where: { recipientId } });
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
    where: {
      recipientId: recipient.id,
      lockedAt: null,
      identityStatus: { notIn: ['LINKED', 'CONFIRMED', 'SKIPPED'] },
    },
    data: { identityStatus: 'LINKED', cpf, pendingCpf: null, identityConfirmedAt: new Date() },
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
  // CC e VIEWER não assinam (não passam pelo portão); quem já assinou (inclusive antes da Fase 3) lê sem portão.
  if (recipient.role === 'CC' || recipient.role === 'VIEWER' || recipient.signingStatus === 'SIGNED') {
    return { status: 'PASSED' };
  }

  const gate = await ensureRevalleGate(recipient);

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
  } catch (error) {
    logRevalleBaseUnavailable(error);

    return { status: 'UNAVAILABLE' };
  }

  return { status: 'IDENTITY_REQUIRED', attemptsLeft: Math.max(0, REVALLE_MAX_ATTEMPTS - gate.failedAttempts) };
};
