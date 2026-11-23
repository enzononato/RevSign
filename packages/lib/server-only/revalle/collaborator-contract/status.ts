import { prisma } from '@documenso/prisma';
import { ReadStatus, RevalleBulkSendStatus, SigningStatus } from '@prisma/client';
import { AppError, AppErrorCode } from '../../../errors/app-error';
import {
  buildCollaboratorStatusCsv,
  bulkSendFailureLabel,
  collaboratorDocStatus,
  type RevalleCollaboratorStatusRow,
} from '../../../revalle/collaborator-contract';
import { assertCollaboratorContractAdmin } from './create-from-envelope';

/** Falhas listadas no quadro (a planilha de situação traz todas). */
const FAILURES_IN_PANEL = 50;

const findContractOrThrow = async (templateEnvelopeId: string) => {
  const contract = await prisma.revalleCollaboratorContract.findUnique({ where: { templateEnvelopeId } });

  if (!contract) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Este modelo não é um contrato para colaboradores.' });
  }

  return contract;
};

const signerOf = <T extends { role: string }>(recipients: T[]) =>
  recipients.find((recipient) => recipient.role === 'SIGNER') ?? recipients[0] ?? null;

/**
 * Quadro "Envio para colaboradores" (só admin): total da planilha, repetidas puladas, na fila, enviados, falharam (com o
 * motivo), visualizados, assinados e recusados. Modelo comum: null. Só nome, e-mail e situação; nunca CPF.
 */
export const getCollaboratorContractStatus = async ({
  templateEnvelopeId,
  userId,
}: {
  templateEnvelopeId: string;
  userId: number;
}) => {
  await assertCollaboratorContractAdmin(userId);

  const contract = await prisma.revalleCollaboratorContract.findUnique({ where: { templateEnvelopeId } });

  if (!contract) {
    return null;
  }

  const queueOf = { envelope: { revalleBulkSendQueue: { contractId: contract.id } } };
  const sentQueueOf = {
    envelope: { revalleBulkSendQueue: { contractId: contract.id, status: RevalleBulkSendStatus.SENT } },
  };

  const [uploads, byStatus, opened, signed, rejected, failures] = await Promise.all([
    prisma.revalleBulkSendUpload.aggregate({
      where: { contractId: contract.id },
      _sum: { totalRows: true, duplicateRows: true, skippedCount: true, failedCount: true },
      _count: { completedAt: true, _all: true },
    }),
    prisma.revalleBulkSendQueue.groupBy({
      by: ['status'],
      where: { contractId: contract.id },
      _count: { _all: true },
    }),
    prisma.recipient.count({ where: { ...sentQueueOf, role: 'SIGNER', readStatus: ReadStatus.OPENED } }),
    prisma.recipient.count({ where: { ...queueOf, role: 'SIGNER', signingStatus: SigningStatus.SIGNED } }),
    prisma.recipient.count({ where: { ...queueOf, role: 'SIGNER', signingStatus: SigningStatus.REJECTED } }),
    prisma.revalleBulkSendQueue.findMany({
      where: { contractId: contract.id, status: RevalleBulkSendStatus.FAILED },
      orderBy: { updatedAt: 'desc' },
      take: FAILURES_IN_PANEL,
      select: {
        id: true,
        lastErrorCode: true,
        updatedAt: true,
        envelope: { select: { recipients: { select: { name: true, email: true, role: true } } } },
      },
    }),
  ]);

  const countOf = (status: RevalleBulkSendStatus) => byStatus.find((row) => row.status === status)?._count._all ?? 0;

  return {
    paused: contract.paused,
    sourceEnvelopeId: contract.sourceEnvelopeId,
    sourceVerificationCode: contract.sourceVerificationCode,
    representativeName: contract.representativeName,
    representativeSignedAt: contract.representativeSignedAt,
    /** Alguma planilha ainda criando documentos (o job em segundo plano). */
    isProcessing: uploads._count._all > uploads._count.completedAt,
    counts: {
      totalRows: uploads._sum.totalRows ?? 0,
      duplicateRows: (uploads._sum.duplicateRows ?? 0) + (uploads._sum.skippedCount ?? 0),
      notCreated: uploads._sum.failedCount ?? 0,
      queued: countOf(RevalleBulkSendStatus.QUEUED),
      sent: countOf(RevalleBulkSendStatus.SENT),
      failed: countOf(RevalleBulkSendStatus.FAILED),
      opened,
      signed,
      rejected,
    },
    failures: failures.map((row) => {
      const signer = signerOf(row.envelope.recipients);

      return {
        id: row.id,
        name: signer?.name ?? '',
        email: signer?.email ?? '',
        reason: bulkSendFailureLabel(row.lastErrorCode),
        date: row.updatedAt,
      };
    }),
  };
};

/** "Baixar planilha da situação": nome;email;situação;data de cada documento do contrato (só admin). */
export const exportCollaboratorContractCsv = async ({
  templateEnvelopeId,
  userId,
}: {
  templateEnvelopeId: string;
  userId: number;
}) => {
  await assertCollaboratorContractAdmin(userId);

  const contract = await findContractOrThrow(templateEnvelopeId);

  const rows = await prisma.revalleBulkSendQueue.findMany({
    where: { contractId: contract.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      status: true,
      lastErrorCode: true,
      createdAt: true,
      updatedAt: true,
      sentAt: true,
      envelope: {
        select: {
          recipients: {
            select: { name: true, email: true, role: true, signingStatus: true, readStatus: true, signedAt: true },
          },
        },
      },
    },
  });

  const statusRows: RevalleCollaboratorStatusRow[] = rows.map((row) => {
    const signer = signerOf(row.envelope.recipients);
    const status = collaboratorDocStatus({
      queueStatus: row.status,
      signingStatus: signer?.signingStatus,
      readStatus: signer?.readStatus,
    });

    const date =
      status === 'SIGNED' || status === 'REJECTED'
        ? (signer?.signedAt ?? row.updatedAt)
        : status === 'QUEUED'
          ? row.createdAt
          : status === 'FAILED'
            ? row.updatedAt
            : row.sentAt;

    return {
      name: signer?.name ?? '',
      email: signer?.email ?? '',
      status,
      failureCode: row.lastErrorCode,
      date,
    };
  });

  return { csv: buildCollaboratorStatusCsv(statusRows), rowCount: statusRows.length };
};

/** Pausar / Retomar o envio em lotes do contrato (só admin). */
export const setCollaboratorContractPaused = async ({
  templateEnvelopeId,
  paused,
  userId,
}: {
  templateEnvelopeId: string;
  paused: boolean;
  userId: number;
}) => {
  await assertCollaboratorContractAdmin(userId);

  const contract = await findContractOrThrow(templateEnvelopeId);

  await prisma.revalleCollaboratorContract.update({ where: { id: contract.id }, data: { paused } });

  return { paused };
};

export type TCollaboratorContractStatus = NonNullable<Awaited<ReturnType<typeof getCollaboratorContractStatus>>>;
