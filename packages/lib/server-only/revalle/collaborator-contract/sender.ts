import { prisma } from '@documenso/prisma';

import { REVALLE_COLLABORATOR_DEFAULT_SENDER_NAME } from '../../../revalle/collaborator-contract';

export type CollaboratorContractEmailSender = {
  /** "Nome do remetente" do contrato: vai no assunto e no corpo do convite no lugar do nome de quem criou. */
  senderName: string;
  /** Resposta ao convite: o admin que criou o contrato. */
  replyTo: string | null;
};

/**
 * REVALLE (v.22): o remetente fixo dos convites de um contrato para colaboradores criado pela página própria — o
 * documento do representante e o de cada colaborador. Documento comum ou contrato da v.21: null (vale o de sempre).
 */
export const findCollaboratorContractEmailSender = async (
  envelopeId: string,
): Promise<CollaboratorContractEmailSender | null> => {
  const contract =
    (await prisma.revalleCollaboratorContract.findUnique({
      where: { representativeEnvelopeId: envelopeId },
      select: { senderName: true, createdById: true },
    })) ??
    (
      await prisma.revalleBulkSendQueue.findUnique({
        where: { envelopeId },
        select: { contract: { select: { senderName: true, createdById: true, representativeEnvelopeId: true } } },
      })
    )?.contract;

  // Só o contrato da página própria (v.22) tem o documento do representante.
  if (!contract || ('representativeEnvelopeId' in contract && !contract.representativeEnvelopeId)) {
    return null;
  }

  const creator = await prisma.user.findUnique({ where: { id: contract.createdById }, select: { email: true } });

  return {
    senderName: contract.senderName?.trim() || REVALLE_COLLABORATOR_DEFAULT_SENDER_NAME,
    replyTo: creator?.email ?? null,
  };
};
