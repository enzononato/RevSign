import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, FieldType, Prisma } from '@prisma/client';
import { z } from 'zod';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { jobs } from '../../../jobs/client';
import {
  dedupeCollaboratorRows,
  REVALLE_COLLABORATOR_CONTRACT_MAX_ROWS,
  type RevalleCollaboratorRow,
} from '../../../revalle/collaborator-contract';
import { normalizeEmail } from '../../../revalle/email-domain';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { mapSecondaryIdToTemplateId } from '../../../utils/envelope';
import { logger } from '../../../utils/logger';
import { createDocumentFromTemplate } from '../../template/create-document-from-template';
import { type TBulkSendCsvError, validateBulkSendCsv } from '../../template/validate-bulk-send-csv';
import { revalleErrorCode } from '../error-code';
import { assertCollaboratorContractAdmin } from './create-from-envelope';

const ZRows = z.array(z.object({ name: z.string(), email: z.string() }));

/** Quanto vale a vez de quem cria os documentos; renovada a cada linha (uma linha leva bem menos que isso). */
const LEASE_MS = 5 * 60 * 1000;

export const COLLABORATOR_UPLOAD_IN_PROGRESS_MESSAGE =
  'Os documentos da planilha anterior ainda estão sendo criados. Espere terminar para enviar outra planilha.';

export const COLLABORATOR_SIGNATURE_REQUIRED_MESSAGE =
  'Posicione a assinatura do colaborador em todos os arquivos do modelo antes de enviar a planilha.';

const invalid = (message: string, statusCode = 400) =>
  new AppError(AppErrorCode.INVALID_REQUEST, { message, userMessage: message, statusCode });

export type CollaboratorBulkSendResult =
  | { success: false; error: TBulkSendCsvError }
  | {
      success: true;
      /** Resumo da planilha: linhas lidas, colaboradores (sem repetidos) e linhas repetidas puladas. */
      revalleCollaboratorContract: { totalRows: number; uniqueRows: number; duplicateRows: number };
    };

/** O modelo tem um só signatário (o colaborador) com assinatura em cada arquivo. */
const assertTemplateReady = async (templateEnvelopeId: string) => {
  const template = await prisma.envelope.findUniqueOrThrow({
    where: { id: templateEnvelopeId },
    select: {
      envelopeItems: { select: { id: true } },
      recipients: { select: { id: true, fields: { select: { type: true, envelopeItemId: true } } } },
    },
  });

  if (template.recipients.length !== 1) {
    throw invalid('O contrato para colaboradores precisa de um só signatário (o colaborador).');
  }

  const signedItems = new Set(
    template.recipients[0].fields
      .filter((field) => field.type === FieldType.SIGNATURE)
      .map((field) => field.envelopeItemId),
  );

  if (template.envelopeItems.some((item) => !signedItems.has(item.id))) {
    throw invalid(COLLABORATOR_SIGNATURE_REQUIRED_MESSAGE);
  }
};

/**
 * Envio em massa de um modelo marcado como contrato para colaboradores (só o admin, 403 para os outros): até 3.000
 * linhas, e-mail obrigatório e válido em cada linha, linhas repetidas pelo mesmo e-mail puladas e contadas. As linhas
 * ficam gravadas no banco (não no payload do job, que vai para o log) e o job cria os documentos na fila de envio. Uma
 * planilha por vez em cada contrato: outra só entra quando a anterior termina.
 */
export const uploadCollaboratorBulkSend = async ({
  contractId,
  templateEnvelopeId,
  csv,
  userId,
}: {
  contractId: string;
  templateEnvelopeId: string;
  csv: string;
  userId: number;
}): Promise<CollaboratorBulkSendResult> => {
  await assertCollaboratorContractAdmin(userId);
  await assertTemplateReady(templateEnvelopeId);

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

  // A trava do contrato faz duas planilhas enviadas ao mesmo tempo virarem uma aceita e uma recusada.
  const upload = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`revalle-collaborator:${contractId}`}))`;

    const open = await tx.revalleBulkSendUpload.count({ where: { contractId, completedAt: null } });

    if (open > 0) {
      throw invalid(COLLABORATOR_UPLOAD_IN_PROGRESS_MESSAGE, 409);
    }

    return await tx.revalleBulkSendUpload.create({
      data: {
        contractId,
        createdById: userId,
        rows,
        totalRows: validation.data.length,
        duplicateRows: duplicates,
      },
      select: { id: true },
    });
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

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

type RowOutcome = 'CREATED' | 'SKIPPED' | 'FAILED';

/**
 * Cria os documentos de uma planilha (job em segundo plano), a partir de `processedRows`: cada linha grava o resultado
 * e avança o ponto de parada, então um novo disparo continua de onde parou. Só um disparo trabalha por vez (a vez em
 * `leaseUntil`); a chave única (contrato, e-mail) da fila garante um documento por e-mail mesmo numa corrida, e o
 * rascunho a mais é apagado. E-mail que já tem documento neste contrato é pulado. Um rascunho deste modelo para o mesmo
 * e-mail sem linha na fila (o job caiu entre criar o documento e gravar a linha) é aproveitado. Devolve o resumo só na
 * primeira vez que a planilha termina.
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
  const leaseFrom = () => new Date(Date.now() + LEASE_MS);

  const claimed = await prisma.revalleBulkSendUpload.updateMany({
    where: { id: uploadId, completedAt: null, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
    data: { leaseUntil: leaseFrom() },
  });

  if (claimed.count === 0) {
    return null;
  }

  const upload = await prisma.revalleBulkSendUpload.findUniqueOrThrow({
    where: { id: uploadId },
    include: {
      contract: {
        select: {
          id: true,
          templateEnvelope: { select: { id: true, secondaryId: true, title: true, teamId: true } },
        },
      },
    },
  });

  const contractId = upload.contract.id;
  const template = upload.contract.templateEnvelope;
  const rows: RevalleCollaboratorRow[] = ZRows.parse(upload.rows);

  try {
    if (template) {
      const templateId = mapSecondaryIdToTemplateId(template.secondaryId);
      const [templateRecipient] = await prisma.recipient.findMany({
        where: { envelopeId: template.id },
        orderBy: [{ signingOrder: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
        take: 1,
        select: { id: true },
      });

      const requestMetadata: ApiRequestMetadata = { source: 'app', auth: 'session', requestMetadata: {} };

      for (let index = upload.processedRows; index < rows.length; index += 1) {
        const email = normalizeEmail(rows[index].email);
        let outcome: RowOutcome;

        try {
          outcome = await processRow({
            contractId,
            templateId,
            templateRecipientId: templateRecipient?.id,
            teamId: template.teamId,
            createdById: upload.createdById,
            email,
            name: rows[index].name,
            requestMetadata,
          });
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
            leaseUntil: leaseFrom(),
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
  } finally {
    // Caiu no meio: devolve a vez para o próximo disparo (o retry do job ou a varredura).
    await prisma.revalleBulkSendUpload.updateMany({
      where: { id: uploadId, completedAt: null, processedRows: { lt: rows.length } },
      data: { leaseUntil: null },
    });
  }

  // Terminou: as linhas (nomes e e-mails) saem do banco; os documentos e a fila ficam.
  const finished = await prisma.revalleBulkSendUpload.updateMany({
    where: { id: uploadId, completedAt: null },
    data: { completedAt: new Date(), leaseUntil: null, rows: [] },
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

const processRow = async ({
  contractId,
  templateId,
  templateRecipientId,
  teamId,
  createdById,
  email,
  name,
  requestMetadata,
}: {
  contractId: string;
  templateId: number;
  templateRecipientId: number | undefined;
  teamId: number;
  createdById: number;
  email: string;
  name: string;
  requestMetadata: ApiRequestMetadata;
}): Promise<RowOutcome> => {
  const existing = await prisma.revalleBulkSendQueue.findUnique({
    where: { contractId_email: { contractId, email } },
    select: { id: true },
  });

  if (existing) {
    return 'SKIPPED';
  }

  if (templateRecipientId === undefined) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'TEMPLATE_WITHOUT_RECIPIENT' });
  }

  const orphan = await prisma.envelope.findFirst({
    where: {
      type: EnvelopeType.DOCUMENT,
      templateId,
      status: DocumentStatus.DRAFT,
      userId: createdById,
      revalleBulkSendQueue: null,
      recipients: { some: sameEmail(email) },
    },
    select: { id: true },
  });

  const envelopeId =
    orphan?.id ??
    (
      await createDocumentFromTemplate({
        id: { type: 'templateId', id: templateId },
        userId: createdById,
        teamId,
        recipients: [{ id: templateRecipientId, email, name }],
        requestMetadata,
      })
    ).id;

  const recipient = await prisma.recipient.findFirstOrThrow({
    where: { envelopeId, ...sameEmail(email) },
    select: { id: true },
  });

  try {
    await prisma.revalleBulkSendQueue.create({ data: { envelopeId, contractId, recipientId: recipient.id, email } });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    // Outro disparo já pôs este e-mail na fila: o rascunho que sobrou (sem linha na fila) sai.
    await prisma.envelope.deleteMany({ where: { id: envelopeId, revalleBulkSendQueue: null } });

    return 'SKIPPED';
  }

  return 'CREATED';
};
