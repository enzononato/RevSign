import { prisma } from '@documenso/prisma';
import {
  DocumentStatus,
  EnvelopeType,
  FieldType,
  RecipientRole,
  RevalleCollaboratorContractStatus,
} from '@prisma/client';

import { REVALLE_COLLABORATOR_RECIPIENT_NAME } from '../../../revalle/collaborator-contract';
import { clampSignatureRect, ZSignatureRectSchema } from '../../../revalle/collaborator-contract-rect';
import { DEFAULT_DOCUMENT_EMAIL_SETTINGS } from '../../../types/document-email';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { putPdfFileServerSide } from '../../../universal/upload/put-file.server';
import { logger } from '../../../utils/logger';
import { createEnvelope } from '../../envelope/create-envelope';
import { processCollaboratorBulkSendUpload } from './bulk-send';
import { contractPagesOf, representativeProofOf } from './create-from-envelope';

const SYSTEM_REQUEST_METADATA: ApiRequestMetadata = { source: 'app', auth: null, requestMetadata: {} };

/** A trava do contrato (a mesma do envio da planilha na v.21). */
export const lockCollaboratorContract = async (
  tx: { $queryRaw: typeof prisma.$queryRaw },
  contractId: string,
): Promise<void> => {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`revalle-collaborator:${contractId}`}))`;
};

type PrepareOutcome = 'NOT_FOUND' | 'NOT_READY' | 'REJECTED' | 'READY';

/**
 * O modelo do contrato, a partir do documento assinado pelo representante: as páginas assinadas (sem certificado e
 * auditoria, como na v.21), um signatário genérico com a assinatura no quadro verde, e o código e o nome do
 * representante guardados para a linha "Assinado pela empresa". Sob a trava do contrato e só a partir de "Aguardando
 * representante": a segunda chamada (o mesmo evento outra vez, a varredura) encontra o contrato pronto e não cria nada.
 */
const prepareContractTemplate = async (contractId: string): Promise<PrepareOutcome> =>
  await prisma.$transaction(
    async (tx) => {
      await lockCollaboratorContract(tx, contractId);

      const contract = await tx.revalleCollaboratorContract.findUnique({ where: { id: contractId } });

      if (!contract) {
        return 'NOT_FOUND';
      }

      if (contract.status === RevalleCollaboratorContractStatus.REJECTED_BY_REPRESENTATIVE) {
        return 'REJECTED';
      }

      if (contract.status !== RevalleCollaboratorContractStatus.AWAITING_REPRESENTATIVE) {
        return contract.templateEnvelopeId ? 'READY' : 'NOT_READY';
      }

      if (!contract.representativeEnvelopeId || contract.teamId === null || !contract.collaboratorRect) {
        return 'NOT_READY';
      }

      const source = await prisma.envelope.findUnique({
        where: { id: contract.representativeEnvelopeId },
        select: {
          status: true,
          title: true,
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
        },
      });

      if (!source || source.status !== DocumentStatus.COMPLETED || source.envelopeItems.length === 0) {
        return 'NOT_READY';
      }

      const representative = representativeProofOf(source.recipients);

      if (!representative) {
        return 'NOT_READY';
      }

      // O documento do representante tem um arquivo só (o PDF do assistente).
      const [item] = source.envelopeItems;
      const bytes = await contractPagesOf(item.documentData);
      const { documentData } = await putPdfFileServerSide({
        name: item.title,
        type: 'application/pdf',
        arrayBuffer: async () => Promise.resolve(bytes),
      });

      const rect = clampSignatureRect(ZSignatureRectSchema.parse(contract.collaboratorRect));
      const title = contract.title?.trim() || source.title;

      const template = await createEnvelope({
        userId: contract.createdById,
        teamId: contract.teamId,
        internalVersion: 2,
        normalizePdf: false,
        bypassDefaultRecipients: true,
        data: {
          type: EnvelopeType.TEMPLATE,
          title,
          envelopeItems: [{ title: item.title, documentDataId: documentData.id, order: 1 }],
          recipients: [
            {
              email: 'recipient.1@documenso.com',
              name: REVALLE_COLLABORATOR_RECIPIENT_NAME,
              role: RecipientRole.SIGNER,
              signingOrder: 1,
              fields: [{ type: FieldType.SIGNATURE, documentDataId: documentData.id, ...rect }],
            },
          ],
        },
        // Centenas de documentos: o dono não recebe um e-mail a cada assinatura nem a cada conclusão.
        meta: {
          emailSettings: { ...DEFAULT_DOCUMENT_EMAIL_SETTINGS, recipientSigned: false, ownerDocumentCompleted: false },
        },
        requestMetadata: SYSTEM_REQUEST_METADATA,
      });

      await tx.revalleCollaboratorContract.update({
        where: { id: contractId },
        data: {
          templateEnvelopeId: template.id,
          sourceEnvelopeId: contract.representativeEnvelopeId,
          sourceVerificationCode: representative.verificationCode,
          representativeName: representative.representativeName,
          representativeSignedAt: representative.signedAt,
          status: contract.paused
            ? RevalleCollaboratorContractStatus.PAUSED
            : RevalleCollaboratorContractStatus.SENDING,
        },
      });

      return 'READY';
    },
    { maxWait: 10_000, timeout: 120_000 },
  );

/**
 * Depois que o representante assina: o modelo (uma vez) e um rascunho por colaborador da lista, cada um com a linha na
 * fila (com o CPF da lista). Rodar de novo — o mesmo evento outra vez, o retry do job, a varredura — continua de onde
 * parou e nunca cria um documento a mais (a vez da planilha e a chave única contrato + e-mail da fila). A lista sai do
 * banco quando termina. Devolve só um resumo para o log (sem dado pessoal).
 */
export const buildCollaboratorDocuments = async ({ contractId }: { contractId: string }): Promise<string> => {
  const outcome = await prepareContractTemplate(contractId);

  if (outcome !== 'READY') {
    return outcome;
  }

  const uploads = await prisma.revalleBulkSendUpload.findMany({
    where: { contractId, completedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  let created = 0;

  for (const upload of uploads) {
    const summary = await processCollaboratorBulkSendUpload({ uploadId: upload.id });

    if (summary) {
      created += summary.createdCount;

      if (summary.failedCount > 0) {
        logger.warn({
          msg: '[RevSign] contrato para colaboradores: linhas que não viraram documento',
          contractId,
          failed: summary.failedCount,
        });
      }
    }
  }

  return `READY (${created} documento(s) criado(s) agora)`;
};
