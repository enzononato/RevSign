// REVALLE: integração com o Patrimônio. Criar, consultar, cancelar e reenviar termos, e baixar o PDF selado. Tudo passa
// pelas funções do Documenso (createEnvelope, sendDocument, cancelDocument, resendDocument); só aqui o envio e o reenvio
// de um termo (`revalleAllowPatrimonioTermo`) são ligados.

import { prisma } from '@documenso/prisma';
import {
  DocumentDistributionMethod,
  DocumentStatus,
  EnvelopeType,
  FieldType,
  Prisma,
  RecipientRole,
  SigningStatus,
} from '@prisma/client';
import type { PatrimonioCreateTermoFields } from '../../../revalle/patrimonio/request';
import { assertTermoFile, PatrimonioError } from '../../../revalle/patrimonio/request';
import { sha256Hex } from '../../../revalle/sha256';
import { FIELD_SIGNATURE_META_DEFAULT_VALUES } from '../../../types/field-meta';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import { putPdfFileServerSide } from '../../../universal/upload/put-file.server';
import { logger } from '../../../utils/logger';
import { cancelDocument } from '../../document/cancel-document';
import { resendDocument } from '../../document/resend-document';
import { sendDocument } from '../../document/send-document';
import { createEnvelope } from '../../envelope/create-envelope';
import { normalizePdf } from '../../pdf/normalize-pdf';
import { getColaboradoresRepository } from '../colaboradores/repository';
import { revalleErrorCode } from '../error-code';
import type { PatrimonioSender } from './config';
import { applySignatureMarkers } from './signature-marker';
import { computeTermoStatus, type PatrimonioTermoStatus } from './webhook';

export const PATRIMONIO_RESEND_INTERVAL_MS = 10 * 60_000;

/** Rascunho que ficou para trás (o app caiu entre criar e enviar): depois disso o `externalId` é liberado. */
const ABANDONED_DRAFT_MS = 5 * 60_000;

const termoInclude = {
  envelope: {
    select: {
      id: true,
      title: true,
      status: true,
      deletedAt: true,
      completedAt: true,
      documentMetaId: true,
      recipients: {
        where: { role: RecipientRole.SIGNER },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          name: true,
          email: true,
          signingStatus: true,
          signedAt: true,
          expiresAt: true,
          rejectionReason: true,
          sentAt: true,
        },
      },
    },
  },
} satisfies Prisma.RevallePatrimonioTermoInclude;

type TermoRow = Prisma.RevallePatrimonioTermoGetPayload<{ include: typeof termoInclude }>;

const statusOf = (termo: TermoRow): PatrimonioTermoStatus => {
  const [signer] = termo.envelope.recipients;

  return computeTermoStatus({
    envelopeStatus: termo.envelope.status,
    deletedAt: termo.envelope.deletedAt,
    signer: signer ? { signingStatus: signer.signingStatus, expiresAt: signer.expiresAt } : null,
  });
};

export type PatrimonioTermoView = {
  termoId: string;
  externalId: string;
  kind: string;
  title: string;
  status: PatrimonioTermoStatus;
  createdAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  signer: {
    name: string;
    email: string;
    signedAt: string | null;
    expiresAt: string | null;
    rejectionReason: string | null;
  };
};

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

/** O que o Patrimônio vê de um termo. Nunca leva o CPF. */
const toView = (termo: TermoRow): PatrimonioTermoView => {
  const status = statusOf(termo);
  const [signer] = termo.envelope.recipients;

  return {
    termoId: termo.envelopeId,
    externalId: termo.externalId,
    kind: termo.kind,
    title: termo.envelope.title,
    status,
    createdAt: termo.createdAt.toISOString(),
    completedAt: status === 'SIGNED' || status === 'REJECTED' ? iso(termo.envelope.completedAt) : null,
    cancelledAt: iso(termo.cancelledAt),
    cancelReason: termo.cancelReason,
    signer: {
      name: signer?.name ?? '',
      email: signer?.email ?? '',
      signedAt: signer?.signingStatus === 'SIGNED' ? iso(signer.signedAt) : null,
      expiresAt: iso(signer?.expiresAt),
      rejectionReason: signer?.signingStatus === 'REJECTED' ? (signer.rejectionReason ?? null) : null,
    },
  };
};

const loadTermo = async (termoId: string): Promise<TermoRow> => {
  const termo =
    termoId.length <= 100
      ? await prisma.revallePatrimonioTermo.findUnique({ where: { envelopeId: termoId }, include: termoInclude })
      : null;

  if (!termo) {
    throw new PatrimonioError('NOT_FOUND', 'Termo não encontrado.');
  }

  return termo;
};

export const getPatrimonioTermo = async (termoId: string) => toView(await loadTermo(termoId));

export const findPatrimonioTermosByExternalId = async (externalId: string) => {
  const termos = await prisma.revallePatrimonioTermo.findMany({
    where: { externalId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: termoInclude,
  });

  return termos.map(toView);
};

/** Apaga um rascunho criado aqui que não chegou a sair (a linha do termo some junto, pela FK). */
const discardDraft = async (envelopeId: string, documentMetaId: string | null) => {
  try {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.envelope.deleteMany({ where: { id: envelopeId, status: DocumentStatus.DRAFT } });

      if (count > 0 && documentMetaId) {
        await tx.documentMeta.deleteMany({ where: { id: documentMetaId } });
      }
    });
  } catch (error) {
    logger.error({ msg: '[RevSign] Patrimônio: rascunho não apagado', envelopeId, code: revalleErrorCode(error) });
  }
};

const duplicateError = (termoId: string) =>
  new PatrimonioError('DUPLICATE_EXTERNAL_ID', 'Já existe um termo pendente com este externalId.', {
    extra: { termoId },
  });

/** Recusa se já há termo pendente com o `externalId`; libera o `externalId` de termo que já saiu de pendente. */
const assertNoPendingTermo = async (externalId: string) => {
  const existing = await prisma.revallePatrimonioTermo.findUnique({
    where: { activeExternalId: externalId },
    include: termoInclude,
  });

  if (!existing) {
    return;
  }

  const isAbandonedDraft =
    existing.envelope.status === DocumentStatus.DRAFT && Date.now() - existing.createdAt.getTime() > ABANDONED_DRAFT_MS;

  if (isAbandonedDraft) {
    await discardDraft(existing.envelopeId, existing.envelope.documentMetaId);

    return;
  }

  if (statusOf(existing) === 'PENDING') {
    throw duplicateError(existing.envelopeId);
  }

  await prisma.revallePatrimonioTermo.updateMany({
    where: { envelopeId: existing.envelopeId, activeExternalId: externalId },
    data: { activeExternalId: null },
  });
};

const assertColaboradorExists = async (cpf: string) => {
  const repository = getColaboradoresRepository();

  if (!repository) {
    throw new PatrimonioError('HR_BASE_UNAVAILABLE', 'Base de colaboradores indisponível. Tente de novo mais tarde.');
  }

  let found: boolean;

  try {
    found = (await repository.findByCpf(cpf)) !== null;
  } catch (error) {
    logger.error({ msg: '[RevSign] Patrimônio: base de colaboradores indisponível', code: revalleErrorCode(error) });

    throw new PatrimonioError('HR_BASE_UNAVAILABLE', 'Base de colaboradores indisponível. Tente de novo mais tarde.');
  }

  if (!found) {
    throw new PatrimonioError('COLABORADOR_NOT_FOUND', 'CPF não encontrado na base de colaboradores.');
  }
};

/** Normaliza o PDF, acha os marcadores e cobre cada um. Lança INVALID_FILE ou MARKER_NOT_FOUND. */
const preparePdf = async (file: Buffer) => {
  assertTermoFile(file);

  let prepared: Awaited<ReturnType<typeof applySignatureMarkers>>;

  try {
    prepared = await applySignatureMarkers(await normalizePdf(file, { flattenForm: true }));
  } catch (error) {
    if (error instanceof PatrimonioError) {
      throw error;
    }

    throw new PatrimonioError('INVALID_FILE', 'O arquivo não é um PDF válido (ou está protegido por senha).');
  }

  if (prepared.fields.length === 0) {
    throw new PatrimonioError('MARKER_NOT_FOUND', 'O PDF não tem o marcador {{assinatura}}.');
  }

  return prepared;
};

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

export const createPatrimonioTermo = async ({
  sender,
  fields,
  file,
  requestMetadata,
}: {
  sender: PatrimonioSender;
  fields: PatrimonioCreateTermoFields;
  file: Buffer;
  requestMetadata: ApiRequestMetadata;
}): Promise<PatrimonioTermoView> => {
  await assertNoPendingTermo(fields.externalId);
  await assertColaboradorExists(fields.signerCpf);

  const { cleanedPdf, fields: placements } = await preparePdf(file);

  const { documentData } = await putPdfFileServerSide({
    name: `${fields.title}.pdf`,
    type: 'application/pdf',
    arrayBuffer: async () => Promise.resolve(cleanedPdf),
  });

  const envelope = await createEnvelope({
    userId: sender.userId,
    teamId: sender.teamId,
    internalVersion: 2,
    bypassDefaultRecipients: true,
    data: {
      type: EnvelopeType.DOCUMENT,
      title: fields.title,
      externalId: fields.externalId,
      envelopeItems: [{ title: fields.title, documentDataId: documentData.id }],
      recipients: [
        {
          email: fields.signerEmail,
          name: fields.signerName,
          role: RecipientRole.SIGNER,
          fields: placements.map((placement) => ({
            type: FieldType.SIGNATURE,
            fieldMeta: FIELD_SIGNATURE_META_DEFAULT_VALUES,
            documentDataId: documentData.id,
            page: placement.page,
            positionX: placement.positionX,
            positionY: placement.positionY,
            width: placement.width,
            height: placement.height,
          })),
        },
      ],
    },
    meta: {
      message: fields.message ?? null,
      distributionMethod: DocumentDistributionMethod.EMAIL,
    },
    requestMetadata,
  });

  try {
    await prisma.revallePatrimonioTermo.create({
      data: {
        envelopeId: envelope.id,
        externalId: fields.externalId,
        activeExternalId: fields.externalId,
        kind: fields.kind,
        signerCpf: fields.signerCpf,
      },
    });
  } catch (error) {
    await discardDraft(envelope.id, envelope.documentMetaId);

    if (isUniqueViolation(error)) {
      const winner = await prisma.revallePatrimonioTermo.findUnique({
        where: { activeExternalId: fields.externalId },
        select: { envelopeId: true },
      });

      if (winner) {
        throw duplicateError(winner.envelopeId);
      }
    }

    throw error;
  }

  try {
    await sendDocument({
      id: { type: 'envelopeId', id: envelope.id },
      userId: sender.userId,
      teamId: sender.teamId,
      sendEmail: true,
      requestMetadata,
      revalleAllowPatrimonioTermo: true,
    });
  } catch (error) {
    logger.error({
      msg: '[RevSign] Patrimônio: envio do termo falhou',
      envelopeId: envelope.id,
      code: revalleErrorCode(error),
    });

    const current = await prisma.envelope.findUnique({ where: { id: envelope.id }, select: { status: true } });

    // Saiu do rascunho (o envio chegou a gravar): o termo existe e segue; senão, nada fica para trás.
    if (current?.status === DocumentStatus.DRAFT || !current) {
      await discardDraft(envelope.id, envelope.documentMetaId);

      throw new PatrimonioError('INTERNAL_ERROR', 'Não foi possível enviar o termo. Tente de novo.');
    }
  }

  return await getPatrimonioTermo(envelope.id);
};

/**
 * Cancelar e reenviar só com o termo pendente E o colaborador ainda sem assinar: entre a assinatura e o fim da selagem o
 * estado continua PENDING, mas o termo já não pode ser cancelado nem reenviado.
 */
const assertPending = (termo: TermoRow) => {
  const status = statusOf(termo);

  if (status !== 'PENDING' || termo.envelope.status !== DocumentStatus.PENDING) {
    throw new PatrimonioError('NOT_PENDING', 'O termo não está pendente.', { extra: { status } });
  }

  if (termo.envelope.recipients.some((recipient) => recipient.signingStatus !== SigningStatus.NOT_SIGNED)) {
    throw new PatrimonioError('NOT_PENDING', 'O colaborador já assinou; o termo está sendo selado.', {
      extra: { status },
    });
  }
};

export const cancelPatrimonioTermo = async ({
  sender,
  termoId,
  reason,
  requestMetadata,
}: {
  sender: PatrimonioSender;
  termoId: string;
  reason: string | undefined;
  requestMetadata: ApiRequestMetadata;
}) => {
  const termo = await loadTermo(termoId);

  assertPending(termo);

  try {
    await cancelDocument({
      id: { type: 'envelopeId', id: termo.envelopeId },
      userId: sender.userId,
      teamId: sender.teamId,
      reason,
      requestMetadata,
    });
  } catch (error) {
    const after = await loadTermo(termoId);

    if (statusOf(after) !== 'PENDING') {
      throw new PatrimonioError('NOT_PENDING', 'O termo não está pendente.', { extra: { status: statusOf(after) } });
    }

    throw error;
  }

  await prisma.revallePatrimonioTermo.update({
    where: { envelopeId: termo.envelopeId },
    data: { cancelledAt: new Date(), cancelReason: reason ?? null, activeExternalId: null },
  });

  return await getPatrimonioTermo(termoId);
};

export const resendPatrimonioTermo = async ({
  sender,
  termoId,
  requestMetadata,
}: {
  sender: PatrimonioSender;
  termoId: string;
  requestMetadata: ApiRequestMetadata;
}) => {
  const termo = await loadTermo(termoId);

  assertPending(termo);

  const [signer] = termo.envelope.recipients;
  const now = new Date();
  const threshold = new Date(now.getTime() - PATRIMONIO_RESEND_INTERVAL_MS);

  // Reserva o reenvio de forma atômica: dois pedidos juntos mandam um e-mail só.
  const reserved = await prisma.revallePatrimonioTermo.updateMany({
    where: {
      envelopeId: termo.envelopeId,
      OR: [{ lastResendAt: null }, { lastResendAt: { lte: threshold } }],
    },
    data: { lastResendAt: now },
  });

  if (reserved.count === 0) {
    const last = termo.lastResendAt ?? now;
    const retryAfter = Math.max(1, Math.ceil((last.getTime() + PATRIMONIO_RESEND_INTERVAL_MS - now.getTime()) / 1000));

    throw new PatrimonioError('RESEND_TOO_SOON', 'O termo foi reenviado há menos de 10 minutos.', {
      extra: { retryAfterSeconds: retryAfter },
      headers: { 'Retry-After': String(retryAfter) },
    });
  }

  try {
    await resendDocument({
      id: { type: 'envelopeId', id: termo.envelopeId },
      userId: sender.userId,
      teamId: sender.teamId,
      recipients: signer ? [signer.id] : [],
      requestMetadata,
      revalleAllowPatrimonioTermo: true,
    });
  } catch (error) {
    await prisma.revallePatrimonioTermo.updateMany({
      where: { envelopeId: termo.envelopeId, lastResendAt: now },
      data: { lastResendAt: termo.lastResendAt },
    });

    throw error;
  }

  return await getPatrimonioTermo(termoId);
};

/** PDF final selado (com carimbo e certificado), o mesmo do download do Documenso. Só para termo `SIGNED`. */
export const getPatrimonioSignedPdf = async (termoId: string) => {
  const termo = await loadTermo(termoId);

  if (statusOf(termo) !== 'SIGNED') {
    throw new PatrimonioError('NOT_SIGNED', 'O termo ainda não foi assinado.', { extra: { status: statusOf(termo) } });
  }

  const item = await prisma.envelopeItem.findFirst({
    where: { envelopeId: termo.envelopeId },
    orderBy: { order: 'asc' },
    include: { documentData: true },
  });

  if (!item?.documentData) {
    throw new PatrimonioError('NOT_FOUND', 'Arquivo do termo não encontrado.');
  }

  const bytes = Buffer.from(await getFileServerSide({ type: item.documentData.type, data: item.documentData.data }));

  return { bytes, sha256: sha256Hex(bytes), filename: `termo-${termo.envelopeId}.pdf` };
};
