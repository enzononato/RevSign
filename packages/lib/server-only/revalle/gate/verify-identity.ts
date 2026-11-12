import { prisma } from '@documenso/prisma';
import { parseBirthDateInput } from '../../../revalle/birth-date';
import { isValidCpf, maskCpf, normalizeCpf } from '../../../revalle/cpf';
import { normalizeEmail } from '../../../revalle/email-domain';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import type { Colaborador } from '../colaboradores/repository';
import { getColaboradoresRepository } from '../colaboradores/repository';
import { findPatrimonioSignerCpf } from '../patrimonio/gate';
import { getRevalleGateState, logRevalleBaseUnavailable, previewOf } from './get-gate-state';
import { lockRevalleGate } from './lock-gate';
import { REVALLE_MAX_ATTEMPTS, type RevalleGateState } from './types';

const maskForAudit = (input: string) => (normalizeCpf(input).length === 11 ? maskCpf(input) : '***.***.***-**');

type LookupResult = { kind: 'FOUND'; colaborador: Colaborador } | { kind: 'NOT_FOUND' } | { kind: 'UNAVAILABLE' };

// `expectedCpf` (termo do Patrimônio): só o CPF que o Patrimônio informou passa; outro CPF é um erro como os demais.
const lookup = async (cpf: string, birthDate: string, expectedCpf: string | null): Promise<LookupResult> => {
  const isoDate = parseBirthDateInput(birthDate);

  if (!isValidCpf(cpf) || !isoDate) {
    return { kind: 'NOT_FOUND' };
  }

  if (expectedCpf !== null && normalizeCpf(cpf) !== expectedCpf) {
    return { kind: 'NOT_FOUND' };
  }

  const repository = getColaboradoresRepository();

  if (!repository) {
    logRevalleBaseUnavailable();

    return { kind: 'UNAVAILABLE' };
  }

  try {
    const colaborador = await repository.findByCpf(cpf);

    return colaborador && colaborador.dataNascimento === isoDate
      ? { kind: 'FOUND', colaborador }
      : { kind: 'NOT_FOUND' };
  } catch (error) {
    logRevalleBaseUnavailable(error);

    return { kind: 'UNAVAILABLE' };
  }
};

// Reserva a tentativa antes de consultar a base: com requisições em paralelo, no máximo 5 palpites são avaliados.
const reserveAttempt = async (recipientId: number): Promise<number | null> => {
  const rows = await prisma.$queryRaw<Array<{ failedAttempts: number }>>`
    UPDATE "RevalleRecipientGate"
    SET "failedAttempts" = "failedAttempts" + 1, "updatedAt" = now()
    WHERE "recipientId" = ${recipientId} AND "lockedAt" IS NULL AND "failedAttempts" < ${REVALLE_MAX_ATTEMPTS}
    RETURNING "failedAttempts"`;

  return rows[0]?.failedAttempts ?? null;
};

const giveBackAttempt = async (recipientId: number) => {
  await prisma.revalleRecipientGate.updateMany({
    where: { recipientId, failedAttempts: { gt: 0 } },
    data: { failedAttempts: { decrement: 1 } },
  });
};

export const verifyRevalleIdentity = async ({
  recipientId,
  cpf,
  birthDate,
  requestMetadata,
}: {
  recipientId: number;
  cpf: string;
  birthDate: string;
  requestMetadata: RequestMetadata;
}): Promise<RevalleGateState> => {
  const recipient = await prisma.recipient.findUniqueOrThrow({
    where: { id: recipientId },
    select: { id: true, email: true, name: true, envelopeId: true, role: true, signingStatus: true },
  });

  const current = await getRevalleGateState(recipient, requestMetadata);

  if (current.status !== 'IDENTITY_REQUIRED') {
    return current;
  }

  const attempt = await reserveAttempt(recipientId);

  if (attempt === null) {
    const gate = await prisma.revalleRecipientGate.findUniqueOrThrow({ where: { recipientId } });

    return gate.lockedAt
      ? { status: 'LOCKED' }
      : { status: 'IDENTITY_REQUIRED', attemptsLeft: Math.max(0, REVALLE_MAX_ATTEMPTS - gate.failedAttempts) };
  }

  const patrimonioCpf = await findPatrimonioSignerCpf(recipientId);
  const result = await lookup(cpf, birthDate, patrimonioCpf);

  if (result.kind === 'UNAVAILABLE') {
    await giveBackAttempt(recipientId);

    return { status: 'UNAVAILABLE' };
  }

  if (result.kind === 'FOUND') {
    await giveBackAttempt(recipientId);

    const { colaborador } = result;
    const email = normalizeEmail(recipient.email);

    // Termo do Patrimônio: o Patrimônio responde pela ligação e-mail ↔ colaborador; sem as checagens de conflito.
    const linkedElsewhere =
      patrimonioCpf === null
        ? await prisma.revalleEmailLink.findFirst({
            where: { cpf: colaborador.cpf, email: { not: email } },
            select: { id: true },
          })
        : null;
    const baseEmailDiffers =
      patrimonioCpf === null && colaborador.email !== null && normalizeEmail(colaborador.email) !== email;

    if (linkedElsewhere || baseEmailDiffers) {
      await lockRevalleGate({
        recipientId,
        reason: 'CPF_CONFLICT',
        conflictCpf: colaborador.cpf,
        requestMetadata,
      });

      return { status: 'LOCKED' };
    }

    const verified = await prisma.revalleRecipientGate.updateMany({
      where: { recipientId, lockedAt: null },
      data: { identityStatus: 'VERIFIED', pendingCpf: colaborador.cpf },
    });

    return verified.count === 0 ? { status: 'LOCKED' } : previewOf(colaborador);
  }

  await prisma.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_IDENTITY_FAILED,
      envelopeId: recipient.envelopeId,
      data: { attempt, cpfMasked: maskForAudit(cpf) },
      user: { name: recipient.name, email: recipient.email },
      requestMetadata,
    }),
  });

  if (attempt >= REVALLE_MAX_ATTEMPTS) {
    await lockRevalleGate({ recipientId, reason: 'ATTEMPTS', requestMetadata });

    return { status: 'LOCKED' };
  }

  return { status: 'IDENTITY_REQUIRED', attemptsLeft: REVALLE_MAX_ATTEMPTS - attempt };
};
