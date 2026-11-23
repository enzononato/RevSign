import { prisma } from '@documenso/prisma';

import { buildCollaboratorContractLine } from '../../../revalle/collaborator-contract';
import { mapTemplateIdToSecondaryId } from '../../../utils/envelope';

/**
 * REVALLE (v.21): o documento criado de um contrato para colaboradores tem uma linha em `RevalleBulkSendQueue` (a marca
 * "sem conta"). Nele a regra "e-mail da empresa precisa de conta" não vale e o portão pede CPF e data de nascimento em
 * todo documento.
 */
export const isCollaboratorContractRecipient = async (recipientId: number): Promise<boolean> => {
  const row = await prisma.revalleBulkSendQueue.findFirst({
    where: { envelope: { recipients: { some: { id: recipientId } } } },
    select: { id: true },
  });

  return row !== null;
};

export type CollaboratorContractLine = {
  /** "Assinado pela empresa: {nome} em {data}, código {código}" (certificado e `/verificar`). */
  text: string;
  /** Código de verificação do representante, para o link do `/verificar` dele. */
  verificationCode: string;
};

/** A linha do representante para o documento de um colaborador; documento comum, null. */
export const loadCollaboratorContractLine = async (envelopeId: string): Promise<CollaboratorContractLine | null> => {
  const row = await prisma.revalleBulkSendQueue.findUnique({
    where: { envelopeId },
    select: {
      contract: {
        select: { representativeName: true, representativeSignedAt: true, sourceVerificationCode: true },
      },
    },
  });

  if (!row) {
    return null;
  }

  const { contract } = row;

  return {
    text: buildCollaboratorContractLine({
      representativeName: contract.representativeName,
      signedAt: contract.representativeSignedAt,
      verificationCode: contract.sourceVerificationCode,
    }),
    verificationCode: contract.sourceVerificationCode,
  };
};

/** O contrato do modelo (pelo id do envelope do modelo); modelo comum, null. */
export const findCollaboratorContractByTemplateEnvelopeId = async (templateEnvelopeId: string) =>
  await prisma.revalleCollaboratorContract.findUnique({ where: { templateEnvelopeId } });

/**
 * O endereço `/templates/:id` (id do envelope ou o número antigo do modelo) é de um modelo marcado? Só esses modelos
 * abrem para o admin; Modelos continua fora da tela para todos (Fase 7).
 */
export const isCollaboratorContractTemplatePath = async (id: string): Promise<boolean> => {
  const legacyId = Number(id);
  const where =
    Number.isInteger(legacyId) && legacyId > 0 ? { secondaryId: mapTemplateIdToSecondaryId(legacyId) } : { id };

  const row = await prisma.revalleCollaboratorContract.findFirst({
    where: { templateEnvelope: where },
    select: { id: true },
  });

  return row !== null;
};
