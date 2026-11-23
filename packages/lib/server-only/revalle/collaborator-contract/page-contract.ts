import { prisma } from '@documenso/prisma';
import { PDF } from '@libpdf/core';
import {
  EnvelopeType,
  FieldType,
  Prisma,
  ReadStatus,
  RecipientRole,
  RevalleCollaboratorContractStatus,
  SigningStatus,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import {
  effectiveCollaboratorContractStatus,
  REVALLE_COLLABORATOR_CONTRACT_MAX_ROWS,
  REVALLE_COLLABORATOR_DEFAULT_SENDER_NAME,
} from '../../../revalle/collaborator-contract';
import {
  clampSignatureRect,
  type SignatureRect,
  ZSignatureRectSchema,
} from '../../../revalle/collaborator-contract-rect';
import type { ParsedRow } from '../../../revalle/collaborator-rows';
import { normalizeCpf } from '../../../revalle/cpf';
import { normalizeEmail } from '../../../revalle/email-domain';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import { logger } from '../../../utils/logger';
import { createEnvelope } from '../../envelope/create-envelope';
import { isRevalleExternalEmail } from '../assert-recipient-domains';
import { revalleErrorCode } from '../error-code';
import { assertCollaboratorContractAdmin } from './create-from-envelope';
import { sendToRepresentative } from './representative';
import { ensureCollaboratorContractTeam } from './team';
import { validateCollaboratorRows } from './validate-rows';

// REVALLE (v.22): contrato para colaboradores pela página própria (só administrador do sistema). O assistente grava o
// rascunho; "Enviar para o representante" confere tudo de novo no servidor, guarda a lista (só as linhas prontas) e
// manda o documento ao representante. Os documentos dos colaboradores nascem quando ele assina (`build-documents.ts`).

/** Linha da lista já conferida na prévia; aqui é conferida de novo. */
export type ContractRowInput = { name: string; email: string; cpf: string };

export type CollaboratorContractDraftFields = {
  title?: string | null;
  senderName?: string | null;
  documentDataId?: string | null;
  representativeEmail?: string | null;
  representativeRect?: SignatureRect | null;
  collaboratorRect?: SignatureRect | null;
};

const invalid = (message: string, statusCode = 400) =>
  new AppError(AppErrorCode.INVALID_REQUEST, { message, userMessage: message, statusCode });

const notFound = () =>
  new AppError(AppErrorCode.NOT_FOUND, {
    message: 'Contrato não encontrado.',
    userMessage: 'Contrato não encontrado.',
    statusCode: 404,
  });

const ALREADY_SENT_MESSAGE = 'Este contrato já foi enviado.';

const jsonRect = (rect: SignatureRect | null | undefined) =>
  rect === undefined ? undefined : rect === null ? Prisma.DbNull : clampSignatureRect(rect);

const draftData = (fields: CollaboratorContractDraftFields) => ({
  title: fields.title === undefined ? undefined : fields.title?.trim() || null,
  senderName: fields.senderName === undefined ? undefined : fields.senderName?.trim() || null,
  sourcePdfDocumentDataId: fields.documentDataId,
  representativeEmail:
    fields.representativeEmail === undefined
      ? undefined
      : fields.representativeEmail
        ? normalizeEmail(fields.representativeEmail)
        : null,
});

/** Grava o rascunho do assistente (cria na primeira vez). Contrato já enviado não volta a ser rascunho. */
export const saveCollaboratorContractDraft = async ({
  userId,
  contractId,
  fields,
}: {
  userId: number;
  contractId?: string;
  fields: CollaboratorContractDraftFields;
}): Promise<{ contractId: string }> => {
  await assertCollaboratorContractAdmin(userId);

  const data = {
    ...draftData(fields),
    representativeRect: jsonRect(fields.representativeRect),
    collaboratorRect: jsonRect(fields.collaboratorRect),
  };

  if (!contractId) {
    const created = await prisma.revalleCollaboratorContract.create({
      data: { ...data, createdById: userId, status: RevalleCollaboratorContractStatus.DRAFT },
      select: { id: true },
    });

    return { contractId: created.id };
  }

  const updated = await prisma.revalleCollaboratorContract.updateMany({
    where: { id: contractId, status: RevalleCollaboratorContractStatus.DRAFT },
    data,
  });

  if (updated.count === 0) {
    const exists = await prisma.revalleCollaboratorContract.findUnique({
      where: { id: contractId },
      select: { id: true },
    });

    throw exists ? invalid(ALREADY_SENT_MESSAGE, 409) : notFound();
  }

  return { contractId };
};

/** O PDF subido pelo assistente: existe, ainda não é de nenhum documento, e tem as páginas dos dois quadros. */
const assertContractPdf = async (documentDataId: string, rects: SignatureRect[]) => {
  const [documentData, usedBy] = await Promise.all([
    prisma.documentData.findUnique({ where: { id: documentDataId }, select: { type: true, data: true } }),
    prisma.envelopeItem.findFirst({ where: { documentDataId }, select: { id: true } }),
  ]);

  if (!documentData || usedBy) {
    throw invalid('Suba o PDF do contrato de novo.');
  }

  let pageCount: number;

  try {
    pageCount = (await PDF.load(await getFileServerSide(documentData))).getPageCount();
  } catch {
    throw invalid('Não foi possível ler o PDF do contrato.');
  }

  if (rects.some((rect) => rect.page > pageCount)) {
    throw invalid('Um quadro de assinatura está numa página que o PDF não tem.');
  }
};

/**
 * "Enviar para o representante". Confere de novo no servidor: e-mail do representante da empresa, PDF e quadros, e a
 * lista contra a base do RH (só as linhas sem nenhum problema entram, com o nome do RH quando a base tem). Grava a lista
 * no banco (fora do payload de job, que vai para o log), cria o documento do representante no time "Contratos para
 * colaboradores" com a assinatura no quadro azul e envia. Com `contractId`, é o rascunho do assistente que é enviado (uma
 * vez só: o segundo clique recebe 409).
 */
export const createCollaboratorContract = async ({
  userId,
  contractId,
  title,
  senderName,
  documentDataId,
  representativeEmail,
  representativeRect,
  collaboratorRect,
  rows,
  requestMetadata,
}: {
  userId: number;
  contractId?: string;
  title: string;
  senderName?: string | null;
  documentDataId: string;
  representativeEmail: string;
  representativeRect: SignatureRect;
  collaboratorRect: SignatureRect;
  rows: ContractRowInput[];
  requestMetadata: ApiRequestMetadata;
}): Promise<{ contractId: string }> => {
  await assertCollaboratorContractAdmin(userId);

  // O segundo clique responde 409 antes de conferir de novo (o PDF já é do documento do representante).
  if (contractId) {
    const existing = await prisma.revalleCollaboratorContract.findUnique({
      where: { id: contractId },
      select: { status: true },
    });

    if (!existing) {
      throw notFound();
    }

    if (existing.status !== RevalleCollaboratorContractStatus.DRAFT) {
      throw invalid(ALREADY_SENT_MESSAGE, 409);
    }
  }

  const cleanTitle = title.trim();
  const repEmail = normalizeEmail(representativeEmail);
  const repRect = clampSignatureRect(ZSignatureRectSchema.parse(representativeRect));
  const colabRect = clampSignatureRect(ZSignatureRectSchema.parse(collaboratorRect));

  if (!cleanTitle) {
    throw invalid('Dê um título ao contrato.');
  }

  if (!repEmail || isRevalleExternalEmail(repEmail)) {
    throw invalid('O e-mail do representante tem de ser da empresa.');
  }

  if (rows.length === 0 || rows.length > REVALLE_COLLABORATOR_CONTRACT_MAX_ROWS) {
    throw invalid('A lista precisa ter de 1 a 3.000 colaboradores.');
  }

  await assertContractPdf(documentDataId, [repRect, colabRect]);

  const parsed: ParsedRow[] = rows.map((row, index) => ({
    line: index + 1,
    name: row.name.trim(),
    email: normalizeEmail(row.email),
    cpf: normalizeCpf(row.cpf),
  }));

  const preview = await validateCollaboratorRows(parsed);
  const ready = preview.rows
    .filter((row) => row.issues.length === 0)
    .map((row) => ({ name: (row.hrName ?? row.name).trim(), email: normalizeEmail(row.email), cpf: row.cpf }));

  if (ready.length === 0) {
    throw invalid('Nenhum colaborador da lista está pronto para receber o contrato.');
  }

  const teamId = await ensureCollaboratorContractTeam(userId);

  const contractData = {
    title: cleanTitle,
    senderName: senderName?.trim() || REVALLE_COLLABORATOR_DEFAULT_SENDER_NAME,
    teamId,
    representativeEmail: repEmail,
    representativeRect: repRect,
    collaboratorRect: colabRect,
    sourcePdfDocumentDataId: documentDataId,
    status: RevalleCollaboratorContractStatus.AWAITING_REPRESENTATIVE,
  };

  // O rascunho vira "Aguardando representante" de uma vez (o segundo clique não acha mais o rascunho).
  const id = await prisma.$transaction(async (tx) => {
    let id: string;

    if (contractId) {
      const claimed = await tx.revalleCollaboratorContract.updateMany({
        where: { id: contractId, status: RevalleCollaboratorContractStatus.DRAFT },
        data: contractData,
      });

      if (claimed.count === 0) {
        throw invalid(ALREADY_SENT_MESSAGE, 409);
      }

      id = contractId;
    } else {
      id = (
        await tx.revalleCollaboratorContract.create({
          data: { ...contractData, createdById: userId },
          select: { id: true },
        })
      ).id;
    }

    await tx.revalleBulkSendUpload.create({
      data: { contractId: id, createdById: userId, rows: ready, totalRows: ready.length, duplicateRows: 0 },
    });

    return id;
  });

  let representativeEnvelopeId: string;

  try {
    const account = await prisma.user.findFirst({
      where: { email: { equals: repEmail, mode: 'insensitive' } },
      select: { name: true },
    });

    const envelope = await createEnvelope({
      userId,
      teamId,
      internalVersion: 2,
      normalizePdf: false,
      bypassDefaultRecipients: true,
      data: {
        type: EnvelopeType.DOCUMENT,
        title: cleanTitle,
        envelopeItems: [{ title: cleanTitle, documentDataId, order: 1 }],
        recipients: [
          {
            email: repEmail,
            name: account?.name?.trim() ?? '',
            role: RecipientRole.SIGNER,
            signingOrder: 1,
            fields: [{ type: FieldType.SIGNATURE, documentDataId, ...repRect }],
          },
        ],
      },
      requestMetadata,
    });

    representativeEnvelopeId = envelope.id;

    await prisma.revalleCollaboratorContract.update({ where: { id }, data: { representativeEnvelopeId } });
  } catch (error) {
    // Nada foi enviado: volta a ser rascunho e a lista sai do banco (o assistente envia de novo).
    await prisma.$transaction([
      prisma.revalleBulkSendUpload.deleteMany({ where: { contractId: id, completedAt: null } }),
      prisma.revalleCollaboratorContract.update({
        where: { id },
        data: { status: RevalleCollaboratorContractStatus.DRAFT },
      }),
    ]);

    throw error;
  }

  try {
    await sendToRepresentative({ representativeEnvelopeId, requestMetadata });
  } catch (error) {
    // O documento fica como rascunho; "Reenviar para o representante" na página do contrato envia de novo.
    logger.warn({
      msg: '[RevSign] contrato para colaboradores: envio ao representante falhou',
      contractId: id,
      code: revalleErrorCode(error),
    });

    throw error;
  }

  return { contractId: id };
};

type CountsRow = { queued: number; sent: number; viewed: number; signed: number; rejected: number; failed: number };

const emptyCounts = (): CountsRow => ({ queued: 0, sent: 0, viewed: 0, signed: 0, rejected: 0, failed: 0 });

/**
 * Situação de cada documento do contrato, em grupos que não se repetem: na fila, enviado (sem abrir), visualizado,
 * assinado, recusado, falhou. Contagem no banco (um contrato pode ter 3.000 documentos).
 */
const countsOf = async (contractId: string): Promise<CountsRow> => {
  const rows = await prisma.$queryRaw<Array<{ bucket: string; total: bigint }>>`
    SELECT CASE
             WHEN q.status = 'QUEUED' THEN 'queued'
             WHEN q.status = 'FAILED' THEN 'failed'
             WHEN r."signingStatus" = 'SIGNED' THEN 'signed'
             WHEN r."signingStatus" = 'REJECTED' THEN 'rejected'
             WHEN r."readStatus" = 'OPENED' THEN 'viewed'
             ELSE 'sent'
           END AS bucket,
           count(*) AS total
    FROM "RevalleBulkSendQueue" q
    LEFT JOIN "Recipient" r ON r.id = q."recipientId"
    WHERE q."contractId" = ${contractId}
    GROUP BY 1`;

  const counts = emptyCounts();

  for (const row of rows) {
    if (row.bucket in counts) {
      counts[row.bucket as keyof CountsRow] = Number(row.total);
    }
  }

  return counts;
};

const summaryOf = async (contract: { id: string; status: RevalleCollaboratorContractStatus; paused: boolean }) => {
  const [counts, uploads] = await Promise.all([
    countsOf(contract.id),
    prisma.revalleBulkSendUpload.aggregate({
      where: { contractId: contract.id },
      _sum: { totalRows: true, duplicateRows: true, skippedCount: true },
      _count: { completedAt: true, _all: true },
    }),
  ]);

  const queueTotal = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const expected = (uploads._sum.totalRows ?? 0) - (uploads._sum.duplicateRows ?? 0) - (uploads._sum.skippedCount ?? 0);
  const isBuilding = uploads._count._all > uploads._count.completedAt;
  // Recusado pelo representante: a lista nunca virou documento.
  const total =
    contract.status === RevalleCollaboratorContractStatus.REJECTED_BY_REPRESENTATIVE
      ? queueTotal
      : Math.max(queueTotal, expected);

  return {
    counts,
    total,
    isBuilding,
    status: effectiveCollaboratorContractStatus({
      status: contract.status,
      paused: contract.paused,
      total,
      finished: counts.signed + counts.rejected + counts.failed,
      isBuilding,
    }),
  };
};

/** Lista "Contratos para colaboradores": os da página própria e os da v.21 (só leitura da situação). */
export const listCollaboratorContracts = async ({ userId }: { userId: number }) => {
  await assertCollaboratorContractAdmin(userId);

  const contracts = await prisma.revalleCollaboratorContract.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      status: true,
      paused: true,
      createdAt: true,
      representativeEnvelopeId: true,
      templateEnvelope: { select: { title: true } },
    },
  });

  return {
    contracts: await Promise.all(
      contracts.map(async (contract) => {
        const summary = await summaryOf(contract);

        return {
          id: contract.id,
          title: contract.title ?? contract.templateEnvelope?.title ?? '',
          status: summary.status,
          total: summary.total,
          signed: summary.counts.signed,
          createdAt: contract.createdAt,
          /** Contrato da v.21 (modelo + planilha): só a situação. */
          isLegacy: contract.representativeEnvelopeId === null && contract.status !== 'DRAFT',
        };
      }),
    ),
  };
};

const representativeOf = async (representativeEnvelopeId: string | null) => {
  if (!representativeEnvelopeId) {
    return null;
  }

  const envelope = await prisma.envelope.findUnique({
    where: { id: representativeEnvelopeId },
    select: {
      status: true,
      team: { select: { url: true } },
      recipients: {
        where: { role: RecipientRole.SIGNER },
        orderBy: { id: 'asc' },
        take: 1,
        select: { name: true, email: true, signingStatus: true, readStatus: true, sendStatus: true, signedAt: true },
      },
    },
  });

  const [signer] = envelope?.recipients ?? [];

  if (!envelope || !signer) {
    return null;
  }

  const status =
    signer.signingStatus === SigningStatus.SIGNED
      ? 'SIGNED'
      : signer.signingStatus === SigningStatus.REJECTED
        ? 'REJECTED'
        : envelope.status === 'DRAFT'
          ? 'NOT_SENT'
          : signer.readStatus === ReadStatus.OPENED
            ? 'OPENED'
            : 'SENT';

  return {
    status: status as 'NOT_SENT' | 'SENT' | 'OPENED' | 'SIGNED' | 'REJECTED',
    signedAt: signer.signingStatus === SigningStatus.NOT_SIGNED ? null : signer.signedAt,
    name: signer.name,
    email: signer.email,
    envelopeId: representativeEnvelopeId,
    teamUrl: envelope.team.url,
  };
};

/**
 * Página do contrato: os dados do contrato (também os do rascunho, para o assistente continuar), as contagens por
 * situação e o representante. Sem a lista de colaboradores (ver `rows`) e nunca com CPF.
 */
export const getCollaboratorContract = async ({ userId, contractId }: { userId: number; contractId: string }) => {
  await assertCollaboratorContractAdmin(userId);

  const contract = await prisma.revalleCollaboratorContract.findUnique({
    where: { id: contractId },
    include: { templateEnvelope: { select: { title: true } } },
  });

  if (!contract) {
    throw notFound();
  }

  const [summary, representative] = await Promise.all([
    summaryOf(contract),
    representativeOf(contract.representativeEnvelopeId ?? contract.sourceEnvelopeId),
  ]);

  const parseRect = (value: unknown) => {
    const parsed = ZSignatureRectSchema.safeParse(value);

    return parsed.success ? parsed.data : null;
  };

  return {
    contract: {
      id: contract.id,
      title: contract.title ?? contract.templateEnvelope?.title ?? '',
      status: summary.status,
      paused: contract.paused,
      senderName: contract.senderName,
      representativeEmail: contract.representativeEmail,
      documentDataId: contract.sourcePdfDocumentDataId,
      representativeRect: parseRect(contract.representativeRect),
      collaboratorRect: parseRect(contract.collaboratorRect),
      total: summary.total,
      isBuilding: summary.isBuilding,
      isLegacy: contract.representativeEnvelopeId === null && contract.status !== 'DRAFT',
      createdAt: contract.createdAt,
    },
    counts: summary.counts,
    representative: representative
      ? {
          ...representative,
          // O nome que vale no certificado (o do RH), quando ele já assinou.
          name: contract.representativeName ?? representative.name,
        }
      : null,
  };
};
