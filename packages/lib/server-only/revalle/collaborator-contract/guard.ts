import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { isAdmin } from '../../../utils/is-admin';

// REVALLE (v.21): o documento de um colaborador (na fila) e o modelo marcado ficam como o admin os deixou. Um membro do
// time que trocasse o PDF, os destinatários, os campos ou os arquivos faria um conteúdo qualquer ser assinado sem conta
// e ganhar "Assinado pela empresa". Só o administrador do sistema altera; o envio pela fila não passa por aqui.

export const COLLABORATOR_CONTRACT_LOCKED_MESSAGE =
  'Este documento é de um contrato para colaboradores: só o administrador pode alterá-lo.';

export type CollaboratorContractActor = { userId?: number | null; isAdmin?: boolean };

export const isCollaboratorContractEnvelope = async (
  envelopeId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<boolean> => {
  const [queued, contract, representative] = await Promise.all([
    tx.revalleBulkSendQueue.findUnique({ where: { envelopeId }, select: { id: true } }),
    tx.revalleCollaboratorContract.findUnique({ where: { templateEnvelopeId: envelopeId }, select: { id: true } }),
    // v.22: o documento do representante (o PDF e os quadros vêm do assistente).
    tx.revalleCollaboratorContract.findUnique({
      where: { representativeEnvelopeId: envelopeId },
      select: { id: true },
    }),
  ]);

  return queued !== null || contract !== null || representative !== null;
};

const isActorAdmin = async (actor: CollaboratorContractActor | undefined, tx: Prisma.TransactionClient) => {
  if (actor?.isAdmin) {
    return true;
  }

  if (!actor?.userId) {
    return false;
  }

  const user = await tx.user.findUnique({ where: { id: actor.userId }, select: { roles: true } });

  return user !== null && isAdmin(user);
};

/** 403 quando o envelope é do contrato para colaboradores e quem altera não é administrador do sistema. */
export const assertCollaboratorContractMutable = async ({
  envelopeId,
  actor,
  tx = prisma,
}: {
  envelopeId: string;
  actor?: CollaboratorContractActor;
  tx?: Prisma.TransactionClient;
}): Promise<void> => {
  if (!(await isCollaboratorContractEnvelope(envelopeId, tx))) {
    return;
  }

  if (await isActorAdmin(actor, tx)) {
    return;
  }

  throw new AppError(AppErrorCode.FORBIDDEN, {
    message: COLLABORATOR_CONTRACT_LOCKED_MESSAGE,
    userMessage: COLLABORATOR_CONTRACT_LOCKED_MESSAGE,
    statusCode: 403,
  });
};

/** O modelo marcado não ganha link direto: os documentos saem só pela planilha, com a marca. */
export const assertNotCollaboratorContractTemplate = async (templateEnvelopeId: string): Promise<void> => {
  const contract = await prisma.revalleCollaboratorContract.findUnique({
    where: { templateEnvelopeId },
    select: { id: true },
  });

  if (contract) {
    const message = 'O contrato para colaboradores sai só pelo envio da planilha, sem link direto.';

    throw new AppError(AppErrorCode.FORBIDDEN, { message, userMessage: message, statusCode: 403 });
  }
};
