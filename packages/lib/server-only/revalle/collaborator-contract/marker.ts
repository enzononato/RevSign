import { prisma } from '@documenso/prisma';

import { SigningStatus } from '@prisma/client';

import { buildCollaboratorContractLine } from '../../../revalle/collaborator-contract';
import { normalizeEmail } from '../../../revalle/email-domain';
import { mapTemplateIdToSecondaryId } from '../../../utils/envelope';

/**
 * REVALLE (v.21): o documento criado de um contrato para colaboradores tem uma linha em `RevalleBulkSendQueue` (a marca
 * "sem conta"). Para o colaborador dessa linha (o mesmo destinatário, com o mesmo e-mail), a regra "e-mail da empresa
 * precisa de conta" não vale e o portão pede CPF e data de nascimento em todo documento. Outro destinatário, ou o
 * mesmo com o e-mail trocado, segue a regra de sempre.
 */
export const isCollaboratorContractRecipient = async (recipientId: number): Promise<boolean> => {
  const row = await prisma.revalleBulkSendQueue.findUnique({
    where: { recipientId },
    select: { email: true, envelopeId: true },
  });

  if (!row) {
    return false;
  }

  const recipient = await prisma.recipient.findUnique({
    where: { id: recipientId },
    select: { email: true, envelopeId: true },
  });

  return recipient !== null && recipient.envelopeId === row.envelopeId && normalizeEmail(recipient.email) === row.email;
};

/**
 * v.22: o CPF da lista para o colaborador desta linha da fila (o mesmo destinatário, com o mesmo e-mail). Como no termo
 * do Patrimônio, o portão só aceita este CPF. Documento da v.21 (sem CPF) ou outro destinatário: null.
 */
export const findCollaboratorContractRecipientCpf = async (recipientId: number): Promise<string | null> => {
  const row = await prisma.revalleBulkSendQueue.findUnique({
    where: { recipientId },
    select: { cpf: true, email: true, envelopeId: true },
  });

  if (!row?.cpf) {
    return null;
  }

  const recipient = await prisma.recipient.findUnique({
    where: { id: recipientId },
    select: { email: true, envelopeId: true },
  });

  return recipient !== null && recipient.envelopeId === row.envelopeId && normalizeEmail(recipient.email) === row.email
    ? row.cpf
    : null;
};

export type CollaboratorContractLine = {
  /** "Assinado pela empresa: {nome} em {data}, código {código}" (certificado e `/verificar`). */
  text: string;
  /** Código de verificação do representante, para o link do `/verificar` dele. */
  verificationCode: string;
};

/**
 * A linha do representante para o documento de um colaborador; documento comum, null. Só quando quem assinou é o
 * colaborador da fila, com o e-mail de quando o documento foi criado (o documento não muda depois: ver `guard.ts`).
 */
export const loadCollaboratorContractLine = async (envelopeId: string): Promise<CollaboratorContractLine | null> => {
  const row = await prisma.revalleBulkSendQueue.findUnique({
    where: { envelopeId },
    select: {
      recipientId: true,
      email: true,
      contract: {
        select: { representativeName: true, representativeSignedAt: true, sourceVerificationCode: true },
      },
    },
  });

  if (!row) {
    return null;
  }

  const signer = await prisma.recipient.findFirst({
    where: { id: row.recipientId, envelopeId, signingStatus: SigningStatus.SIGNED },
    select: { email: true },
  });

  if (!signer || normalizeEmail(signer.email) !== row.email) {
    return null;
  }

  const { contract } = row;

  // v.22: a linha só existe depois que o representante assinou (o documento do colaborador nasce daí).
  if (!contract.representativeName || !contract.representativeSignedAt || !contract.sourceVerificationCode) {
    return null;
  }

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
