import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { maskCpf } from '../../../revalle/cpf';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { logger } from '../../../utils/logger';
import { type Colaborador, getColaboradoresRepository } from '../colaboradores/repository';

type Admin = { id: number; email: string; name: string | null };

export const findLockedRevalleGates = async ({ cursor, limit }: { cursor?: string; limit: number }) => {
  const gates = await prisma.revalleRecipientGate.findMany({
    where: { lockedAt: { not: null } },
    orderBy: [{ lockedAt: 'desc' }, { id: 'asc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      lockedAt: true,
      lockReason: true,
      recipient: { select: { email: true, envelope: { select: { id: true, title: true } } } },
    },
  });

  const page = gates.slice(0, limit);

  return {
    items: page.map((gate) => ({
      id: gate.id,
      documentTitle: gate.recipient.envelope.title,
      recipientEmail: gate.recipient.email,
      reason: gate.lockReason === 'CPF_CONFLICT' ? ('CPF_CONFLICT' as const) : ('ATTEMPTS' as const),
      lockedAt: gate.lockedAt as Date,
    })),
    nextCursor: gates.length > limit ? page[page.length - 1].id : null,
  };
};

export const unlockRevalleGate = async ({
  gateId,
  admin,
  requestMetadata,
}: {
  gateId: string;
  admin: Admin;
  requestMetadata: RequestMetadata;
}) => {
  const unlocked = await prisma.revalleRecipientGate.updateMany({
    where: { id: gateId, lockedAt: { not: null } },
    data: { failedAttempts: 0, lockedAt: null, lockReason: null, identityStatus: 'PENDING', pendingCpf: null },
  });

  if (unlocked.count === 0) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Link bloqueado não encontrado.', statusCode: 404 });
  }

  const gate = await prisma.revalleRecipientGate.findUniqueOrThrow({
    where: { id: gateId },
    select: { recipient: { select: { envelopeId: true, name: true, email: true } } },
  });

  await prisma.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_GATE_UNLOCKED,
      envelopeId: gate.recipient.envelopeId,
      data: { unlockedBy: admin.email },
      user: { name: gate.recipient.name, email: gate.recipient.email },
      requestMetadata,
    }),
  });

  logger.info({ msg: `[RevSign] link desbloqueado por ${admin.email}`, gateId });
};

export const findRevalleEmailLinks = async ({
  search,
  cursor,
  limit,
}: {
  search?: string;
  cursor?: string;
  limit: number;
}) => {
  const links = await prisma.revalleEmailLink.findMany({
    where: search?.trim() ? { email: { contains: search.trim(), mode: 'insensitive' } } : {},
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const page = links.slice(0, limit);
  const names = new Map<string, string>();

  try {
    const repository = getColaboradoresRepository();

    if (repository) {
      await Promise.all(
        page.map(async (link) => {
          try {
            const person: Colaborador | null = await repository.findByCpf(link.cpf);

            if (person) {
              names.set(link.id, person.nome);
            }
          } catch {
            // nome é opcional
          }
        }),
      );
    }
  } catch {
    // base fora do ar: lista sem nomes
  }

  return {
    items: page.map((link) => ({
      id: link.id,
      email: link.email,
      name: names.get(link.id) ?? null,
      cpfMasked: maskCpf(link.cpf),
      createdAt: link.createdAt,
    })),
    nextCursor: links.length > limit ? page[page.length - 1].id : null,
  };
};

export const deleteRevalleEmailLink = async ({ linkId, admin }: { linkId: string; admin: Admin }) => {
  const deleted = await prisma.revalleEmailLink.deleteMany({ where: { id: linkId } });

  if (deleted.count === 0) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Vínculo não encontrado.', statusCode: 404 });
  }

  logger.info({ msg: `[RevSign] vínculo removido por ${admin.email}`, linkId });
};
