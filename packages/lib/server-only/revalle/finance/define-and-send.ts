import { prisma } from '@documenso/prisma';
import type { RevalleInvoiceClassification } from '@prisma/client';
import { DocumentStatus, RevalleFinanceStatus, RevalleInvoiceStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { logger } from '../../../utils/logger';
import { sendDocument } from '../../document/send-document';

export type ResendInvoiceVersionResult = { sent: boolean };

const NOT_A_VERSION_MESSAGE = 'Esta nota fiscal não tem uma nova versão aguardando envio.';
const IN_PROGRESS_MESSAGE = 'O envio desta nota já está em andamento. Aguarde um instante.';
const FILE_CHANGED_MESSAGE = 'O remetente trocou o arquivo; a nota voltou para ele.';

/**
 * `APPROVED` com o documento ainda em rascunho = o envio do Financeiro está em andamento (a "reserva" é `approvedAt`).
 * Passado esse prazo, o envio morreu no meio (queda do processo entre a reserva e o envio) e a reserva pode ser
 * retomada; antes dele, outro pedido recebe 409. O mesmo prazo da troca de conta: o envio (injeção dos campos num PDF
 * grande) pode passar de alguns minutos, e retomar antes disso enviaria duas vezes ao mesmo tempo.
 */
export const FINANCE_SEND_LEASE_MS = 5 * 60 * 1000;

const inProgressError = () =>
  new AppError('FINANCE_SEND_IN_PROGRESS', {
    message: IN_PROGRESS_MESSAGE,
    userMessage: IN_PROGRESS_MESSAGE,
    statusCode: 409,
  });

const notAVersionError = () =>
  new AppError(AppErrorCode.INVALID_REQUEST, { message: NOT_A_VERSION_MESSAGE, userMessage: NOT_A_VERSION_MESSAGE });

// O dono trocou o arquivo do rascunho: a classificação foi zerada e a NF voltou a ser um rascunho dele.
const fileChangedError = () =>
  new AppError(AppErrorCode.INVALID_REQUEST, { message: FILE_CHANGED_MESSAGE, userMessage: FILE_CHANGED_MESSAGE });

const hasFileChanged = (
  read: Pick<RevalleInvoiceClassification, 'fileSha256'>,
  latest: Pick<RevalleInvoiceClassification, 'fileSha256' | 'financeStatus'> | null,
) => !latest || latest.financeStatus === null || latest.fileSha256 !== read.fileSha256;

const isStaleLease = (row: RevalleInvoiceClassification, now: Date) =>
  row.approvedAt === null || now.getTime() - row.approvedAt.getTime() >= FINANCE_SEND_LEASE_MS;

/**
 * A reserva só marcou o envio em andamento: a aprovação continua sendo a da troca (mesmo instante da escolha, como no
 * envio feito pelo remetente). Falhar aqui não desfaz o envio.
 */
const restoreApprovalDate = async (envelopeId: string) => {
  try {
    await prisma.$executeRaw`
      UPDATE "RevalleInvoiceClassification"
      SET "approvedAt" = "choiceAt"
      WHERE "envelopeId" = ${envelopeId}
        AND "financeStatus" = 'APPROVED'
        AND "previousEnvelopeId" IS NOT NULL
        AND "approvedAt" IS NOT NULL
        AND "choiceAt" IS NOT NULL`;
  } catch (error) {
    logger.warn({ msg: 'revalle finance: falha ao restaurar a data da aprovação', envelopeId, error: String(error) });
  }
};

/**
 * "Enviar de novo": a nova versão de uma troca de conta (`previousEnvelopeId`) que ficou em rascunho porque o envio
 * dela falhou. Quem é do Financeiro a envia em nome do dono (`sendDocument` com o usuário e o time dele), com a mesma
 * conta que a troca definiu: a conta não é parâmetro. O membro já foi conferido pela rota.
 *
 * Seguro contra queda e contra clique duplo:
 * - a reserva (`approvedAt`) é gravada condicionada ao estado lido, então só um pedido vence;
 * - com o documento em rascunho, uma reserva com menos de 5 minutos é um envio em andamento (409); a solta (`approvedAt`
 *   nulo, o envio falhou) ou a vencida (o envio caiu) é retomada e envia;
 * - documento já enviado: `{ sent: false }`, sem reenviar;
 * - se o envio falhar com o documento ainda em rascunho, a reserva é solta (o próximo envio sai na hora, sem esperar o
 *   prazo), sem convite e sem mudar a conta;
 * - o dono trocou o arquivo no meio (antes da reserva ou durante o envio): a NF voltou a ser rascunho dele, e quem é do
 *   Financeiro recebe "O remetente trocou o arquivo".
 */
export const resendInvoiceVersion = async ({
  envelopeId,
  user,
  requestMetadata,
}: {
  envelopeId: string;
  user: { id: number; name: string | null; email: string };
  requestMetadata: ApiRequestMetadata;
}): Promise<ResendInvoiceVersionResult> => {
  const envelope = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: { userId: true, teamId: true, status: true, deletedAt: true, revalleInvoice: true },
  });

  const row = envelope?.revalleInvoice;

  if (!envelope || envelope.deletedAt || !row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Nota fiscal não encontrada.' });
  }

  const isApprovedVersion = row.previousEnvelopeId !== null && row.financeStatus === RevalleFinanceStatus.APPROVED;

  if (envelope.status !== DocumentStatus.DRAFT) {
    if (isApprovedVersion) {
      return { sent: false };
    }

    throw notAVersionError();
  }

  if (!isApprovedVersion) {
    throw notAVersionError();
  }

  const now = new Date();

  if (!isStaleLease(row, now)) {
    throw inProgressError();
  }

  // Condicionada ao que foi lido: a mesma reserva (`approvedAt`) e os mesmos arquivos.
  const { count } = await prisma.revalleInvoiceClassification.updateMany({
    where: {
      envelopeId,
      isInvoice: RevalleInvoiceStatus.YES,
      fileSha256: row.fileSha256,
      financeStatus: RevalleFinanceStatus.APPROVED,
      approvedAt: row.approvedAt,
    },
    data: { approvedAt: now },
  });

  if (count === 0) {
    // Outro pedido venceu (já enviou, ou ainda está enviando), ou o arquivo mudou.
    const current = await prisma.envelope.findUnique({ where: { id: envelopeId }, select: { status: true } });
    const latest = await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } });

    if (current?.status === DocumentStatus.DRAFT) {
      throw hasFileChanged(row, latest) ? fileChangedError() : inProgressError();
    }

    if (latest?.financeStatus === RevalleFinanceStatus.APPROVED) {
      return { sent: false };
    }

    throw notAVersionError();
  }

  try {
    await sendDocument({
      id: { type: 'envelopeId', id: envelopeId },
      userId: envelope.userId,
      teamId: envelope.teamId,
      requestMetadata,
    });
  } catch (error) {
    const current = await prisma.envelope.findUnique({ where: { id: envelopeId }, select: { status: true } });

    if (current?.status === DocumentStatus.DRAFT) {
      // Só solta a própria reserva (a mesma `approvedAt`): o próximo envio sai na hora.
      await prisma.revalleInvoiceClassification.updateMany({
        where: { envelopeId, financeStatus: RevalleFinanceStatus.APPROVED, approvedAt: now },
        data: { approvedAt: null },
      });

      // O dono trocou o arquivo durante o envio: a classificação foi zerada e o envio recusou a NF sem conta.
      if (hasFileChanged(row, await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } }))) {
        throw fileChangedError();
      }

      throw error;
    }

    // Já saiu (o erro veio depois da distribuição, ex.: um webhook): a nova versão vale.
    logger.warn({
      msg: 'revalle finance: erro depois do reenvio da nova versão',
      envelopeId,
      userId: user.id,
      error: String(error),
    });
  }

  await restoreApprovalDate(envelopeId);

  return { sent: true };
};
