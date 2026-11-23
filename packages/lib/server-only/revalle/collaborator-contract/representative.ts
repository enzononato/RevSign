import { prisma } from '@documenso/prisma';
import { DocumentStatus, RevalleCollaboratorContractStatus, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { jobs } from '../../../jobs/client';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { logger } from '../../../utils/logger';
import { resendDocument } from '../../document/resend-document';
import { sendDocument } from '../../document/send-document';
import { revalleErrorCode } from '../error-code';
import { lockCollaboratorContract } from './build-documents';
import { assertCollaboratorContractAdmin } from './create-from-envelope';

export const COLLABORATOR_CONTRACT_BUILD_JOB_ID = 'internal.revalle-collaborator-contract-build';

/** Contratos olhados por varredura (o caso normal é o evento da selagem; a varredura só recupera o que caiu). */
const RECOVER_BATCH = 20;

const triggerBuild = async (contractId: string) => {
  await jobs.triggerJob({ name: COLLABORATOR_CONTRACT_BUILD_JOB_ID, payload: { contractId } });
};

/**
 * O representante recusou: o contrato fica "Recusado pelo representante", nada entra na fila e a lista sai do banco.
 * Sob a trava do contrato: não cruza com a criação dos documentos.
 */
export const markRepresentativeRejected = async (contractId: string): Promise<boolean> =>
  await prisma.$transaction(async (tx) => {
    await lockCollaboratorContract(tx, contractId);

    const updated = await tx.revalleCollaboratorContract.updateMany({
      where: { id: contractId, status: RevalleCollaboratorContractStatus.AWAITING_REPRESENTATIVE },
      data: { status: RevalleCollaboratorContractStatus.REJECTED_BY_REPRESENTATIVE },
    });

    if (updated.count > 0) {
      await tx.revalleBulkSendUpload.updateMany({
        where: { contractId, completedAt: null },
        data: { rows: [], completedAt: new Date(), leaseUntil: null },
      });
    }

    return updated.count > 0;
  });

/**
 * REVALLE: chamado pela selagem (conclusão ou recusa) de qualquer envelope. Se é o documento do representante de um
 * contrato para colaboradores: concluído, agenda a criação dos documentos; recusado, marca o contrato. Nunca lança: a
 * selagem segue, e a varredura da fila recupera o que falhar aqui.
 */
export const onCollaboratorContractRepresentativeSealed = async ({
  envelopeId,
  isRejected,
}: {
  envelopeId: string;
  isRejected: boolean;
}): Promise<void> => {
  try {
    const contract = await prisma.revalleCollaboratorContract.findUnique({
      where: { representativeEnvelopeId: envelopeId },
      select: { id: true },
    });

    if (!contract) {
      return;
    }

    if (isRejected) {
      await markRepresentativeRejected(contract.id);

      return;
    }

    await triggerBuild(contract.id);
  } catch (error) {
    logger.error({
      msg: '[RevSign] contrato para colaboradores: falha ao reagir à assinatura do representante',
      envelopeId,
      code: revalleErrorCode(error),
    });
  }
};

/**
 * Varredura: contrato ainda "Aguardando representante" cujo documento já foi concluído ou recusado (o evento da
 * selagem se perdeu, ex.: o app reiniciou). Concluído agenda a criação de novo (idempotente); recusado marca.
 */
export const recoverRepresentativeOutcomes = async (): Promise<void> => {
  const waiting = await prisma.revalleCollaboratorContract.findMany({
    where: {
      status: RevalleCollaboratorContractStatus.AWAITING_REPRESENTATIVE,
      representativeEnvelopeId: { not: null },
    },
    orderBy: { updatedAt: 'asc' },
    take: RECOVER_BATCH,
    select: { id: true, representativeEnvelopeId: true },
  });

  for (const contract of waiting) {
    if (!contract.representativeEnvelopeId) {
      continue;
    }

    const envelope = await prisma.envelope.findUnique({
      where: { id: contract.representativeEnvelopeId },
      select: { status: true },
    });

    try {
      if (envelope?.status === DocumentStatus.COMPLETED) {
        await triggerBuild(contract.id);
      } else if (envelope?.status === DocumentStatus.REJECTED) {
        await markRepresentativeRejected(contract.id);
      }
    } catch (error) {
      logger.warn({
        msg: '[RevSign] contrato para colaboradores: recuperação do representante falhou',
        contractId: contract.id,
        code: revalleErrorCode(error),
      });
    }
  }
};

/** Envia (rascunho) ou reenvia (já enviado, ainda sem assinar) o documento ao representante, como o dono dele. */
export const sendToRepresentative = async ({
  representativeEnvelopeId,
  requestMetadata,
}: {
  representativeEnvelopeId: string;
  requestMetadata: ApiRequestMetadata;
}): Promise<void> => {
  const envelope = await prisma.envelope.findUniqueOrThrow({
    where: { id: representativeEnvelopeId },
    select: {
      status: true,
      userId: true,
      teamId: true,
      recipients: { select: { id: true, signingStatus: true } },
    },
  });

  if (envelope.status === DocumentStatus.DRAFT) {
    await sendDocument({
      id: { type: 'envelopeId', id: representativeEnvelopeId },
      userId: envelope.userId,
      teamId: envelope.teamId,
      requestMetadata,
    });

    return;
  }

  const pending = envelope.recipients.filter((recipient) => recipient.signingStatus === SigningStatus.NOT_SIGNED);

  if (envelope.status !== DocumentStatus.PENDING || pending.length === 0) {
    const message = 'O representante já respondeu: não há o que reenviar.';

    throw new AppError(AppErrorCode.INVALID_REQUEST, { message, userMessage: message, statusCode: 400 });
  }

  await resendDocument({
    id: { type: 'envelopeId', id: representativeEnvelopeId },
    userId: envelope.userId,
    teamId: envelope.teamId,
    recipients: pending.map((recipient) => recipient.id),
    requestMetadata,
  });
};

/** "Reenviar para o representante" (só admin, só enquanto o contrato espera por ele). */
export const resendToRepresentative = async ({
  contractId,
  userId,
  requestMetadata,
}: {
  contractId: string;
  userId: number;
  requestMetadata: ApiRequestMetadata;
}): Promise<void> => {
  await assertCollaboratorContractAdmin(userId);

  const contract = await prisma.revalleCollaboratorContract.findUnique({
    where: { id: contractId },
    select: { status: true, representativeEnvelopeId: true },
  });

  if (!contract) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Contrato não encontrado.', statusCode: 404 });
  }

  if (
    contract.status !== RevalleCollaboratorContractStatus.AWAITING_REPRESENTATIVE ||
    !contract.representativeEnvelopeId
  ) {
    const message = 'O contrato não está esperando o representante.';

    throw new AppError(AppErrorCode.INVALID_REQUEST, { message, userMessage: message, statusCode: 400 });
  }

  await sendToRepresentative({ representativeEnvelopeId: contract.representativeEnvelopeId, requestMetadata });
};
