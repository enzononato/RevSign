import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';
import {
  DocumentStatus,
  ReadStatus,
  RecipientRole,
  RevalleBulkSendStatus,
  RevalleCollaboratorContractStatus,
  SigningStatus,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import {
  buildCollaboratorStatusCsv,
  bulkSendFailureLabel,
  collaboratorDocStatus,
  REVALLE_COLLABORATOR_RESEND_INTERVAL_MS,
  type RevalleCollaboratorDocStatus,
  type RevalleCollaboratorStatusRow,
} from '../../../revalle/collaborator-contract';
import { maskCpf, normalizeCpf } from '../../../revalle/cpf';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { resendDocument } from '../../document/resend-document';
import { assertCollaboratorContractAdmin } from './create-from-envelope';

// REVALLE (v.22): acompanhamento do contrato para colaboradores na página própria (só administrador do sistema): a
// tabela com busca e filtro, "Reenviar" por pessoa, "Pausar/Retomar envio" e "Baixar situação". CPF sempre mascarado.

export type CollaboratorRowsFilter = 'ALL' | RevalleCollaboratorDocStatus;

export const RESEND_TOO_SOON_CODE = 'RESEND_TOO_SOON';

const invalid = (message: string, statusCode = 400) =>
  new AppError(AppErrorCode.INVALID_REQUEST, { message, userMessage: message, statusCode });

const findContractOrThrow = async (contractId: string) => {
  const contract = await prisma.revalleCollaboratorContract.findUnique({
    where: { id: contractId },
    select: { id: true, status: true },
  });

  if (!contract) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Contrato não encontrado.',
      userMessage: 'Contrato não encontrado.',
      statusCode: 404,
    });
  }

  return contract;
};

const withSigner = (where: Prisma.RecipientWhereInput): Prisma.RevalleBulkSendQueueWhereInput => ({
  status: RevalleBulkSendStatus.SENT,
  envelope: { recipients: { some: { role: RecipientRole.SIGNER, ...where } } },
});

const FILTERS: Record<RevalleCollaboratorDocStatus, Prisma.RevalleBulkSendQueueWhereInput> = {
  QUEUED: { status: RevalleBulkSendStatus.QUEUED },
  FAILED: { status: RevalleBulkSendStatus.FAILED },
  SENT: withSigner({ signingStatus: SigningStatus.NOT_SIGNED, readStatus: ReadStatus.NOT_OPENED }),
  OPENED: withSigner({ signingStatus: SigningStatus.NOT_SIGNED, readStatus: ReadStatus.OPENED }),
  SIGNED: withSigner({ signingStatus: SigningStatus.SIGNED }),
  REJECTED: withSigner({ signingStatus: SigningStatus.REJECTED }),
};

const searchWhere = (search: string | undefined): Prisma.RevalleBulkSendQueueWhereInput => {
  const term = search?.trim();

  if (!term) {
    return {};
  }

  const digits = normalizeCpf(term);

  return {
    OR: [
      { name: { contains: term, mode: 'insensitive' } },
      { email: { contains: term.toLowerCase() } },
      // Contratos da v.21 não guardam o nome na fila.
      { envelope: { recipients: { some: { name: { contains: term, mode: 'insensitive' } } } } },
      ...(digits.length === 11 ? [{ cpf: digits }] : []),
    ],
  };
};

const queueRowSelect = {
  id: true,
  status: true,
  name: true,
  email: true,
  cpf: true,
  lastErrorCode: true,
  createdAt: true,
  updatedAt: true,
  sentAt: true,
  recipientId: true,
  envelope: {
    select: {
      recipients: {
        select: { id: true, name: true, role: true, signingStatus: true, readStatus: true, signedAt: true },
      },
    },
  },
} satisfies Prisma.RevalleBulkSendQueueSelect;

type QueueRow = Prisma.RevalleBulkSendQueueGetPayload<{ select: typeof queueRowSelect }>;

const describeRow = (row: QueueRow) => {
  const signer =
    row.envelope.recipients.find((recipient) => recipient.id === row.recipientId) ??
    row.envelope.recipients.find((recipient) => recipient.role === RecipientRole.SIGNER) ??
    null;

  const status = collaboratorDocStatus({
    queueStatus: row.status,
    signingStatus: signer?.signingStatus,
    readStatus: signer?.readStatus,
  });

  const at =
    status === 'SIGNED' || status === 'REJECTED'
      ? (signer?.signedAt ?? row.updatedAt)
      : status === 'QUEUED'
        ? row.createdAt
        : status === 'FAILED'
          ? row.updatedAt
          : row.sentAt;

  return { signer, status, at };
};

/** A tabela da página do contrato: filtro por situação, busca por nome, e-mail ou CPF completo, paginada. */
export const findCollaboratorContractRows = async ({
  userId,
  contractId,
  filter,
  search,
  page,
  perPage,
}: {
  userId: number;
  contractId: string;
  filter: CollaboratorRowsFilter;
  search?: string;
  page: number;
  perPage: number;
}) => {
  await assertCollaboratorContractAdmin(userId);
  await findContractOrThrow(contractId);

  const where: Prisma.RevalleBulkSendQueueWhereInput = {
    contractId,
    ...(filter === 'ALL' ? {} : FILTERS[filter]),
    ...searchWhere(search),
  };

  const [rows, total] = await Promise.all([
    prisma.revalleBulkSendQueue.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * perPage,
      take: perPage,
      select: queueRowSelect,
    }),
    prisma.revalleBulkSendQueue.count({ where }),
  ]);

  return {
    rows: rows.map((row) => {
      const { signer, status, at } = describeRow(row);

      return {
        queueId: row.id,
        name: row.name ?? signer?.name ?? '',
        email: row.email,
        cpfMasked: row.cpf ? maskCpf(row.cpf) : null,
        status,
        at,
        failureReason: status === 'FAILED' ? bulkSendFailureLabel(row.lastErrorCode) : null,
      };
    }),
    total,
  };
};

/**
 * "Reenviar" para uma pessoa: o convite de novo (com "Lembrete: "), como o dono do documento, no máximo 1 vez a cada 10
 * minutos por pessoa (429 `RESEND_TOO_SOON`). Só para quem já recebeu e ainda não respondeu.
 */
export const resendCollaboratorInvite = async ({
  userId,
  contractId,
  queueId,
  requestMetadata,
  now = new Date(),
}: {
  userId: number;
  contractId: string;
  queueId: string;
  requestMetadata: ApiRequestMetadata;
  now?: Date;
}): Promise<{ ok: true }> => {
  await assertCollaboratorContractAdmin(userId);

  const row = await prisma.revalleBulkSendQueue.findFirst({
    where: { id: queueId, contractId },
    select: {
      status: true,
      resentAt: true,
      envelopeId: true,
      recipientId: true,
      envelope: { select: { status: true, userId: true, teamId: true } },
    },
  });

  if (!row) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Pessoa não encontrada neste contrato.', statusCode: 404 });
  }

  if (row.status === RevalleBulkSendStatus.QUEUED) {
    throw invalid('Ainda na fila: o convite sai no próximo envio.');
  }

  if (row.status === RevalleBulkSendStatus.FAILED) {
    throw invalid('O envio para esta pessoa falhou: não dá para reenviar.');
  }

  const recipient = await prisma.recipient.findUnique({
    where: { id: row.recipientId },
    select: { signingStatus: true },
  });

  if (row.envelope.status !== DocumentStatus.PENDING || recipient?.signingStatus !== SigningStatus.NOT_SIGNED) {
    throw invalid('Esta pessoa já respondeu: não há o que reenviar.');
  }

  const claimed = await prisma.revalleBulkSendQueue.updateMany({
    where: {
      id: queueId,
      OR: [{ resentAt: null }, { resentAt: { lt: new Date(now.getTime() - REVALLE_COLLABORATOR_RESEND_INTERVAL_MS) } }],
    },
    data: { resentAt: now },
  });

  if (claimed.count === 0) {
    const message = 'Já foi reenviado há menos de 10 minutos. Tente de novo daqui a pouco.';

    throw new AppError(RESEND_TOO_SOON_CODE, { message, userMessage: message, statusCode: 429 });
  }

  try {
    await resendDocument({
      id: { type: 'envelopeId', id: row.envelopeId },
      userId: row.envelope.userId,
      teamId: row.envelope.teamId,
      recipients: [row.recipientId],
      requestMetadata,
    });
  } catch (error) {
    // Não saiu: a vez volta (o próximo clique não espera 10 minutos por um envio que não aconteceu).
    await prisma.revalleBulkSendQueue.updateMany({
      where: { id: queueId, resentAt: now },
      data: { resentAt: row.resentAt },
    });

    throw error;
  }

  return { ok: true };
};

/** "Pausar envio" / "Retomar envio". Antes de o representante assinar também vale: a fila nasce pausada. */
export const setCollaboratorContractPagePaused = async ({
  userId,
  contractId,
  paused,
}: {
  userId: number;
  contractId: string;
  paused: boolean;
}): Promise<{ ok: true }> => {
  await assertCollaboratorContractAdmin(userId);

  const contract = await findContractOrThrow(contractId);

  if (
    contract.status === RevalleCollaboratorContractStatus.DRAFT ||
    contract.status === RevalleCollaboratorContractStatus.REJECTED_BY_REPRESENTATIVE
  ) {
    throw invalid('Este contrato não tem envio para pausar.');
  }

  const isSending =
    contract.status === RevalleCollaboratorContractStatus.SENDING ||
    contract.status === RevalleCollaboratorContractStatus.PAUSED;

  await prisma.revalleCollaboratorContract.update({
    where: { id: contractId },
    data: {
      paused,
      ...(isSending
        ? { status: paused ? RevalleCollaboratorContractStatus.PAUSED : RevalleCollaboratorContractStatus.SENDING }
        : {}),
    },
  });

  return { ok: true };
};

/** "Baixar situação": nome;email;CPF (mascarado);situação;data de cada pessoa do contrato. */
export const exportCollaboratorContractPageCsv = async ({
  userId,
  contractId,
}: {
  userId: number;
  contractId: string;
}) => {
  await assertCollaboratorContractAdmin(userId);
  await findContractOrThrow(contractId);

  const rows = await prisma.revalleBulkSendQueue.findMany({
    where: { contractId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: queueRowSelect,
  });

  const statusRows: RevalleCollaboratorStatusRow[] = rows.map((row) => {
    const { signer, status, at } = describeRow(row);

    return {
      name: row.name ?? signer?.name ?? '',
      email: row.email,
      cpf: row.cpf,
      status,
      failureCode: row.lastErrorCode,
      date: at,
    };
  });

  return { csv: buildCollaboratorStatusCsv(statusRows, { withMaskedCpf: true }), rowCount: statusRows.length };
};
