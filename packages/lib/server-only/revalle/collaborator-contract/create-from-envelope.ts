import { prisma } from '@documenso/prisma';
import { PDF } from '@libpdf/core';
import type { DocumentDataType } from '@prisma/client';
import {
  DocumentStatus,
  EnvelopeType,
  RecipientRole,
  RevalleCollaboratorContractStatus,
  RevalleInvoiceStatus,
  SigningStatus,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { REVALLE_COLLABORATOR_RECIPIENT_NAME } from '../../../revalle/collaborator-contract';
import { DEFAULT_DOCUMENT_EMAIL_SETTINGS } from '../../../types/document-email';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import { putPdfFileServerSide } from '../../../universal/upload/put-file.server';
import { isAdmin } from '../../../utils/is-admin';
import { createEnvelope } from '../../envelope/create-envelope';
import { assertNotPatrimonioTermo } from '../patrimonio/guard';

const FORBIDDEN_MESSAGE = 'Só o administrador pode fazer isso.';

/** Contrato para colaboradores: só o admin (403 para os outros). O papel é lido do banco. */
export const assertCollaboratorContractAdmin = async (userId: number) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { roles: true } });

  if (!user || !isAdmin(user)) {
    throw new AppError(AppErrorCode.FORBIDDEN, { message: FORBIDDEN_MESSAGE, userMessage: FORBIDDEN_MESSAGE });
  }
};

/** O modelo marcado como contrato para colaboradores só vira documento pelo admin; modelo comum, nada muda. */
export const assertCollaboratorContractTemplateUse = async ({
  templateEnvelopeId,
  userId,
}: {
  templateEnvelopeId: string;
  userId: number;
}) => {
  const contract = await prisma.revalleCollaboratorContract.findUnique({
    where: { templateEnvelopeId },
    select: { id: true },
  });

  if (contract) {
    await assertCollaboratorContractAdmin(userId);
  }
};

const invalid = (message: string) =>
  new AppError(AppErrorCode.INVALID_REQUEST, { message, userMessage: message, statusCode: 400 });

/** O contrato já criado deste documento neste time (com o modelo ainda existindo). */
export const findCollaboratorContractForSource = async ({
  sourceEnvelopeId,
  teamId,
}: {
  sourceEnvelopeId: string;
  teamId: number;
}) =>
  await prisma.revalleCollaboratorContract.findFirst({
    where: { sourceEnvelopeId, templateEnvelope: { teamId, type: EnvelopeType.TEMPLATE } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, templateEnvelopeId: true },
  });

/**
 * As páginas do arquivo assinado, sem o certificado e a auditoria que a selagem acrescenta no fim. A selagem copia as
 * páginas do certificado e do log DEPOIS das páginas do arquivo original (`initialData`), então as N primeiras páginas
 * do arquivo selado, com N = páginas do original, são o contrato com o carimbo de quem assinou.
 */
export const contractPagesOf = async (documentData: { type: DocumentDataType; data: string; initialData: string }) => {
  const [sealedBytes, originalBytes] = await Promise.all([
    getFileServerSide({ type: documentData.type, data: documentData.data }),
    getFileServerSide({ type: documentData.type, data: documentData.initialData }),
  ]);

  const [sealed, original] = await Promise.all([PDF.load(sealedBytes), PDF.load(originalBytes)]);
  const pageCount = Math.min(original.getPageCount(), sealed.getPageCount());

  if (pageCount < 1) {
    throw invalid('Não foi possível ler as páginas do documento assinado.');
  }

  const extracted = await sealed.extractPages(Array.from({ length: pageCount }, (_, index) => index));
  const bytes = await extracted.save();

  return bytes.slice().buffer;
};

type RepresentativeRecipient = {
  name: string;
  role: RecipientRole;
  signingStatus: SigningStatus;
  revalleProof: { verificationCode: string; signedAt: Date; employee: unknown } | null;
};

/**
 * O representante: quem assinou (SIGNER) com prova; com mais de um, o primeiro a assinar. O nome segue a regra do
 * carimbo e do /verificar: o do RH; sem ele, o do destinatário.
 */
export const representativeProofOf = (recipients: RepresentativeRecipient[]) => {
  const representative = recipients
    .filter((recipient) => recipient.role === RecipientRole.SIGNER && recipient.signingStatus === SigningStatus.SIGNED)
    .flatMap((recipient) => (recipient.revalleProof ? [{ ...recipient.revalleProof, name: recipient.name }] : []))
    .sort((a, b) => a.signedAt.getTime() - b.signedAt.getTime())[0];

  if (!representative) {
    return null;
  }

  const employee = (representative.employee ?? null) as { nome?: unknown } | null;
  const representativeName =
    typeof employee?.nome === 'string' && employee.nome.trim() ? employee.nome.trim() : representative.name.trim();

  return { verificationCode: representative.verificationCode, signedAt: representative.signedAt, representativeName };
};

/**
 * "Usar como contrato para colaboradores": a partir de um documento concluído, cria no time do admin um modelo com as
 * páginas assinadas (com o carimbo do representante, sem certificado e auditoria), um signatário genérico
 * ("Colaborador") e o título do documento, marcado com a origem e o código de verificação do representante. O admin
 * posiciona a assinatura do colaborador no editor. Se este documento já virou contrato neste time (e o modelo existe),
 * devolve o mesmo modelo.
 */
export const createCollaboratorContractFromEnvelope = async ({
  sourceEnvelopeId,
  userId,
  teamId,
  requestMetadata,
}: {
  sourceEnvelopeId: string;
  userId: number;
  teamId: number;
  requestMetadata: ApiRequestMetadata;
}): Promise<{ templateEnvelopeId: string; created: boolean }> => {
  await assertCollaboratorContractAdmin(userId);

  const existing = await findCollaboratorContractForSource({ sourceEnvelopeId, teamId });

  if (existing?.templateEnvelopeId) {
    return { templateEnvelopeId: existing.templateEnvelopeId, created: false };
  }

  const source = await prisma.envelope.findFirst({
    // Só um documento do time aberto pelo admin (o modelo nasce nesse time).
    where: { id: sourceEnvelopeId, type: EnvelopeType.DOCUMENT, deletedAt: null, teamId },
    select: {
      id: true,
      title: true,
      status: true,
      envelopeItems: {
        orderBy: { order: 'asc' },
        select: { title: true, documentData: { select: { type: true, data: true, initialData: true } } },
      },
      recipients: {
        select: {
          name: true,
          role: true,
          signingStatus: true,
          revalleProof: { select: { verificationCode: true, signedAt: true, employee: true } },
        },
      },
      revalleInvoice: { select: { isInvoice: true } },
    },
  });

  if (!source) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Documento não encontrado.', statusCode: 404 });
  }

  await assertNotPatrimonioTermo(source.id);

  if (source.status !== DocumentStatus.COMPLETED) {
    throw invalid('Só um documento concluído pode virar contrato para colaboradores.');
  }

  if (source.revalleInvoice?.isInvoice === RevalleInvoiceStatus.YES) {
    throw invalid('Nota fiscal não pode virar contrato para colaboradores.');
  }

  const representative = representativeProofOf(source.recipients);

  if (!representative) {
    throw invalid('Este documento não tem o código de verificação de quem assinou.');
  }

  const { representativeName } = representative;

  const envelopeItems = [];

  for (const [index, item] of source.envelopeItems.entries()) {
    const bytes = await contractPagesOf(item.documentData);
    const { documentData } = await putPdfFileServerSide({
      name: item.title,
      type: 'application/pdf',
      arrayBuffer: async () => Promise.resolve(bytes),
    });

    envelopeItems.push({ title: item.title, documentDataId: documentData.id, order: index + 1 });
  }

  const template = await createEnvelope({
    userId,
    teamId,
    internalVersion: 2,
    normalizePdf: false,
    bypassDefaultRecipients: true,
    data: {
      type: EnvelopeType.TEMPLATE,
      title: source.title,
      envelopeItems,
      recipients: [
        {
          email: 'recipient.1@documenso.com',
          name: REVALLE_COLLABORATOR_RECIPIENT_NAME,
          role: RecipientRole.SIGNER,
          signingOrder: 1,
        },
      ],
    },
    // Centenas de documentos: o dono não recebe um e-mail a cada assinatura nem a cada conclusão (o colaborador continua
    // recebendo o convite e a cópia assinada).
    meta: {
      emailSettings: { ...DEFAULT_DOCUMENT_EMAIL_SETTINGS, recipientSigned: false, ownerDocumentCompleted: false },
    },
    requestMetadata,
  });

  await prisma.revalleCollaboratorContract.create({
    data: {
      templateEnvelopeId: template.id,
      sourceEnvelopeId: source.id,
      sourceVerificationCode: representative.verificationCode,
      representativeName,
      representativeSignedAt: representative.signedAt,
      createdById: userId,
      // O contrato da v.21 nasce já assinado pelo representante: o padrão (DRAFT) é do assistente da v.22.
      status: RevalleCollaboratorContractStatus.SENDING,
    },
  });

  return { templateEnvelopeId: template.id, created: true };
};
