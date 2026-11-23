import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType } from '@prisma/client';
import { z } from 'zod';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { jobs } from '../../../jobs/client';
import {
  dedupeCollaboratorRows,
  REVALLE_COLLABORATOR_CONTRACT_MAX_ROWS,
  type RevalleCollaboratorRow,
} from '../../../revalle/collaborator-contract';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { mapSecondaryIdToTemplateId } from '../../../utils/envelope';
import { logger } from '../../../utils/logger';
import { createDocumentFromTemplate } from '../../template/create-document-from-template';
import { type TBulkSendCsvError, validateBulkSendCsv } from '../../template/validate-bulk-send-csv';
import { revalleErrorCode } from '../error-code';
import { assertCollaboratorContractAdmin } from './create-from-envelope';

const ZRows = z.array(z.object({ name: z.string(), email: z.string() }));

export type CollaboratorBulkSendResult =
  | { success: false; error: TBulkSendCsvError }
  | {
      success: true;
      /** Resumo da planilha: linhas lidas, colaboradores (sem repetidos) e linhas repetidas puladas. */
      revalleCollaboratorContract: { totalRows: number; uniqueRows: number; duplicateRows: number };
    };

/**
 * Envio em massa de um modelo marcado como contrato para colaboradores (só o admin, 403 para os outros): até 3.000
 * linhas, e-mail obrigatório e válido em cada linha, linhas repetidas pelo mesmo e-mail puladas e contadas. As linhas
 * ficam gravadas no banco (não no payload do job, que vai para o log) e o job cria os documentos na fila de envio.
 */
export const uploadCollaboratorBulkSend = async ({
  contractId,
  templateRecipientCount,
  csv,
  userId,
}: {
  contractId: string;
  templateRecipientCount: number;
  csv: string;
  userId: number;
}): Promise<CollaboratorBulkSendResult> => {
  await assertCollaboratorContractAdmin(userId);

  if (templateRecipientCount !== 1) {
    const message = 'O contrato para colaboradores precisa de um só signatário (o colaborador).';

    throw new AppError(AppErrorCode.INVALID_REQUEST, { message, userMessage: message, statusCode: 400 });
  }

  const validation = validateBulkSendCsv({
    csvContent: csv,
    recipientCount: 1,
    maxRows: REVALLE_COLLABORATOR_CONTRACT_MAX_ROWS,
  });

  if (!validation.success) {
    return { success: false, error: validation.error };
  }

  // Aqui o e-mail é obrigatório: o modelo não tem e-mail de verdade para usar no lugar.
  const rowErrors = validation.data.flatMap((row, index) =>
    (row.recipient_1_email ?? '').trim() === ''
      ? [{ row: index + 1, column: 'recipient_1_email', message: 'Value must be a valid email' }]
      : [],
  );

  if (rowErrors.length > 0) {
    return { success: false, error: { type: 'INVALID_RECIPIENTS', rowErrors } };
  }

  const { rows, duplicates } = dedupeCollaboratorRows(
    validation.data.map((row) => ({ name: row.recipient_1_name, email: row.recipient_1_email })),
  );

  const upload = await prisma.revalleBulkSendUpload.create({
    data: {
      contractId,
      createdById: userId,
      rows,
      totalRows: validation.data.length,
      duplicateRows: duplicates,
    },
    select: { id: true },
  });

  await jobs.triggerJob({ name: 'internal.revalle-collaborator-bulk-send', payload: { uploadId: upload.id } });

  return {
    success: true,
    revalleCollaboratorContract: {
      totalRows: validation.data.length,
      uniqueRows: rows.length,
      duplicateRows: duplicates,
    },
  };
};

const sameEmail = (email: string) => ({ email: { equals: email, mode: 'insensitive' as const } });

type RowOutcome = 'CREATED' | 'SKIPPED' | 'FAILED';

/**
 * Cria os documentos de uma planilha (job em segundo plano), a partir de `processedRows`: cada linha grava o resultado
 * e avança o ponto de parada, então um novo disparo continua de onde parou. E-mail que já tem documento neste contrato
 * é pulado. Um rascunho deste modelo para o mesmo e-mail sem linha na fila (o job caiu entre criar o documento e
 * gravar a linha) é aproveitado. Devolve o resumo só na primeira vez que a planilha termina.
 */
export const processCollaboratorBulkSendUpload = async ({
  uploadId,
}: {
  uploadId: string;
}): Promise<null | {
  createdById: number;
  templateTitle: string;
  totalRows: number;
  duplicateRows: number;
  createdCount: number;
  skippedCount: number;
  failedCount: number;
}> => {
  const upload = await prisma.revalleBulkSendUpload.findUnique({
    where: { id: uploadId },
    include: {
      contract: {
        select: {
          id: true,
          templateEnvelope: { select: { id: true, secondaryId: true, title: true, deletedAt: true } },
        },
      },
    },
  });

  if (!upload || upload.completedAt) {
    return null;
  }

  const template = upload.contract.templateEnvelope;
  const rows: RevalleCollaboratorRow[] = ZRows.parse(upload.rows);

  if (template && !template.deletedAt) {
    const templateId = mapSecondaryIdToTemplateId(template.secondaryId);
    const owner = await prisma.envelope.findUniqueOrThrow({
      where: { id: template.id },
      select: { teamId: true },
    });
    const [templateRecipient] = await prisma.recipient.findMany({
      where: { envelopeId: template.id },
      orderBy: [{ signingOrder: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      take: 1,
      select: { id: true },
    });

    const requestMetadata: ApiRequestMetadata = { source: 'app', auth: 'session', requestMetadata: {} };

    for (let index = upload.processedRows; index < rows.length; index += 1) {
      const row = rows[index];
      let outcome: RowOutcome;

      try {
        const existing = await prisma.revalleBulkSendQueue.findFirst({
          where: { contractId: upload.contract.id, envelope: { recipients: { some: sameEmail(row.email) } } },
          select: { id: true },
        });

        if (existing) {
          outcome = 'SKIPPED';
        } else {
          const orphan = await prisma.envelope.findFirst({
            where: {
              type: EnvelopeType.DOCUMENT,
              templateId,
              status: DocumentStatus.DRAFT,
              userId: upload.createdById,
              revalleBulkSendQueue: null,
              recipients: { some: sameEmail(row.email) },
            },
            select: { id: true },
          });

          if (!templateRecipient) {
            throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'TEMPLATE_WITHOUT_RECIPIENT' });
          }

          const envelopeId =
            orphan?.id ??
            (
              await createDocumentFromTemplate({
                id: { type: 'templateId', id: templateId },
                userId: upload.createdById,
                teamId: owner.teamId,
                recipients: [{ id: templateRecipient.id, email: row.email, name: row.name }],
                requestMetadata,
              })
            ).id;

          await prisma.revalleBulkSendQueue.create({ data: { envelopeId, contractId: upload.contract.id } });

          outcome = 'CREATED';
        }
      } catch (error) {
        outcome = 'FAILED';

        // Só a linha e o código: nunca nome nem e-mail.
        logger.warn({
          msg: '[RevSign] contrato para colaboradores: linha da planilha falhou',
          uploadId,
          row: index + 1,
          code: revalleErrorCode(error),
        });
      }

      await prisma.revalleBulkSendUpload.update({
        where: { id: uploadId },
        data: {
          processedRows: index + 1,
          createdCount: { increment: outcome === 'CREATED' ? 1 : 0 },
          skippedCount: { increment: outcome === 'SKIPPED' ? 1 : 0 },
          failedCount: { increment: outcome === 'FAILED' ? 1 : 0 },
        },
      });
    }
  } else {
    // Modelo apagado: nada é criado; as linhas restantes contam como falha.
    await prisma.revalleBulkSendUpload.update({
      where: { id: uploadId },
      data: { processedRows: rows.length, failedCount: { increment: rows.length - upload.processedRows } },
    });
  }

  const finished = await prisma.revalleBulkSendUpload.updateMany({
    where: { id: uploadId, completedAt: null },
    data: { completedAt: new Date() },
  });

  if (finished.count === 0) {
    return null;
  }

  const done = await prisma.revalleBulkSendUpload.findUniqueOrThrow({ where: { id: uploadId } });

  return {
    createdById: done.createdById,
    templateTitle: template?.title ?? '',
    totalRows: done.totalRows,
    duplicateRows: done.duplicateRows,
    createdCount: done.createdCount,
    skippedCount: done.skippedCount,
    failedCount: done.failedCount,
  };
};
