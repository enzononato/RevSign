import { prisma } from '@documenso/prisma';
import { DocumentStatus, RevalleBulkSendStatus } from '@prisma/client';

import { jobs } from '../../../jobs/client';
import { REVALLE_BULK_SEND_MAX_ATTEMPTS, revalleBulkSendBatchSize } from '../../../revalle/collaborator-contract';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { env } from '../../../utils/env';
import { logger } from '../../../utils/logger';
import { sendDocument } from '../../document/send-document';
import { revalleErrorCode } from '../error-code';

/** Linha presa por uma varredura que caiu no meio: depois disso, outra varredura pode pegá-la. */
const STALE_LOCK_MS = 10 * 60 * 1000;

const SYSTEM_REQUEST_METADATA: ApiRequestMetadata = { source: 'app', auth: null, requestMetadata: {} };

/** Cada linha da planilha avança `updatedAt`; parada há mais que isso sem terminar, o job caiu (ex.: o app reiniciou). */
const STALLED_UPLOAD_MS = 15 * 60 * 1000;

const resumeStalledUploads = async (now: Date) => {
  const stalled = await prisma.revalleBulkSendUpload.findMany({
    where: { completedAt: null, updatedAt: { lt: new Date(now.getTime() - STALLED_UPLOAD_MS) } },
    select: { id: true },
    take: 5,
  });

  for (const upload of stalled) {
    // Marca o novo disparo: a próxima varredura só dispara de novo se esta também parar.
    await prisma.revalleBulkSendUpload.update({ where: { id: upload.id }, data: { updatedAt: now } });
    await jobs.triggerJob({ name: 'internal.revalle-collaborator-bulk-send', payload: { uploadId: upload.id } });
  }
};

/**
 * Varredura da fila do contrato para colaboradores (a cada 15 minutos): envia até
 * `ceil(NEXT_PRIVATE_REVALLE_BULK_SEND_PER_HOUR / 4)` documentos (padrão 25), os mais antigos primeiro, dos contratos
 * não pausados cujo modelo ainda existe. Cada envio é o `sendDocument` normal (convite com o assunto automático e o
 * comprovante), feito como o dono do documento (quem enviou a planilha). A falha de um documento não para a fila: ele
 * volta para a fila e, na 3ª falha, fica como "falhou" com o código do erro. O log nunca traz nome nem e-mail.
 */
export const sweepCollaboratorSendQueue = async ({ now = new Date() }: { now?: Date } = {}) => {
  await resumeStalledUploads(now);

  const batchSize = revalleBulkSendBatchSize(env('NEXT_PRIVATE_REVALLE_BULK_SEND_PER_HOUR'));
  const unlocked = [{ lockedAt: null }, { lockedAt: { lt: new Date(now.getTime() - STALE_LOCK_MS) } }];

  const candidates = await prisma.revalleBulkSendQueue.findMany({
    where: {
      status: RevalleBulkSendStatus.QUEUED,
      contract: { paused: false, templateEnvelopeId: { not: null } },
      OR: unlocked,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: batchSize,
    select: { id: true, envelopeId: true, attempts: true },
  });

  const result = { sent: 0, retried: 0, failed: 0 };

  for (const candidate of candidates) {
    const claimed = await prisma.revalleBulkSendQueue.updateMany({
      where: { id: candidate.id, status: RevalleBulkSendStatus.QUEUED, OR: unlocked },
      data: { lockedAt: now, attempts: { increment: 1 } },
    });

    if (claimed.count === 0) {
      continue;
    }

    const attempt = candidate.attempts + 1;

    const envelope = await prisma.envelope.findUnique({
      where: { id: candidate.envelopeId },
      select: { status: true, userId: true, teamId: true },
    });

    try {
      if (!envelope) {
        throw Object.assign(new Error('envelope not found'), { code: 'NOT_FOUND' });
      }

      // Já saiu do rascunho (outro envio ganhou a corrida, ou alguém enviou à mão): conta como enviado.
      if (envelope.status === DocumentStatus.DRAFT) {
        await sendDocument({
          id: { type: 'envelopeId', id: candidate.envelopeId },
          userId: envelope.userId,
          teamId: envelope.teamId,
          requestMetadata: SYSTEM_REQUEST_METADATA,
        });
      }

      await prisma.revalleBulkSendQueue.update({
        where: { id: candidate.id },
        data: { status: RevalleBulkSendStatus.SENT, sentAt: new Date(), lockedAt: null, lastErrorCode: null },
      });

      result.sent += 1;
    } catch (error) {
      const code = revalleErrorCode(error);
      const current = await prisma.envelope.findUnique({
        where: { id: candidate.envelopeId },
        select: { status: true },
      });

      // O erro veio depois da distribuição (ex.: um webhook): o documento saiu.
      if (current && current.status !== DocumentStatus.DRAFT) {
        await prisma.revalleBulkSendQueue.update({
          where: { id: candidate.id },
          data: { status: RevalleBulkSendStatus.SENT, sentAt: new Date(), lockedAt: null, lastErrorCode: null },
        });

        result.sent += 1;
        continue;
      }

      const isFinal = attempt >= REVALLE_BULK_SEND_MAX_ATTEMPTS;

      await prisma.revalleBulkSendQueue.update({
        where: { id: candidate.id },
        data: {
          status: isFinal ? RevalleBulkSendStatus.FAILED : RevalleBulkSendStatus.QUEUED,
          lastErrorCode: code.slice(0, 100),
          lockedAt: null,
        },
      });

      if (isFinal) {
        result.failed += 1;
      } else {
        result.retried += 1;
      }

      logger.warn({
        msg: '[RevSign] contrato para colaboradores: envio falhou',
        queueId: candidate.id,
        envelopeId: candidate.envelopeId,
        attempt,
        code,
      });
    }
  }

  return result;
};
