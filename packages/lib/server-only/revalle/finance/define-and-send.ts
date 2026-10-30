import { prisma } from '@documenso/prisma';
import type { RevalleInvoiceClassification } from '@prisma/client';
import { DocumentStatus, RevalleFinanceStatus, RevalleInvoiceStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { logger } from '../../../utils/logger';
import { sendDocument } from '../../document/send-document';
import { toInvoiceState } from '../invoice/classify';

export type DefineInvoiceAccountResult = { sent: boolean };

const NOT_AWAITING_MESSAGE = 'Esta nota fiscal não está aguardando o Financeiro definir a conta.';
const IN_PROGRESS_MESSAGE = 'O envio desta nota já está em andamento. Aguarde um instante.';

/**
 * `APPROVED` com o documento ainda em rascunho = o envio do Financeiro está em andamento (a "reserva" é `approvedAt`).
 * Passado esse prazo, o envio morreu no meio (queda do processo entre a gravação e o envio) e a reserva pode ser
 * retomada; antes dele, outro pedido recebe 409.
 */
export const FINANCE_SEND_LEASE_MS = 2 * 60 * 1000;

const inProgressError = () =>
  new AppError('FINANCE_SEND_IN_PROGRESS', {
    message: IN_PROGRESS_MESSAGE,
    userMessage: IN_PROGRESS_MESSAGE,
    statusCode: 409,
  });

const notAwaitingError = () =>
  new AppError(AppErrorCode.INVALID_REQUEST, { message: NOT_AWAITING_MESSAGE, userMessage: NOT_AWAITING_MESSAGE });

const isStaleLease = (row: RevalleInvoiceClassification, now: Date) =>
  row.approvedAt === null || now.getTime() - row.approvedAt.getTime() >= FINANCE_SEND_LEASE_MS;

/**
 * "Deixar para o Financeiro": quem é do Financeiro define a conta da NF retida e o documento é enviado em nome do dono
 * (`sendDocument` com o usuário e o time dele; como a escolha não é mais "deixar", o envio não fica retido de novo).
 * O membro já foi conferido pela rota.
 *
 * Seguro contra queda e contra clique duplo:
 * - a gravação (conta, `APPROVED`, `approvedBy/At`) é condicionada ao estado lido, então só um pedido vence;
 * - `APPROVED` com o documento em rascunho é a reserva do envio: com menos de 2 minutos, 409 "em andamento"; mais
 *   velha, qualquer conta ativa a retoma (nova `approvedAt`, condicionada à antiga) e envia;
 * - documento já enviado com a mesma conta: `{ sent: false }`, sem reenviar; outra conta é troca (outra rota);
 * - se o envio falhar com o documento ainda em rascunho, a NF volta a aguardar a conta (sem convite, sem evento).
 */
export const defineInvoiceAccountAndSend = async ({
  envelopeId,
  code,
  user,
  requestMetadata,
}: {
  envelopeId: string;
  code: string;
  user: { id: number; name: string | null; email: string };
  requestMetadata: ApiRequestMetadata;
}): Promise<DefineInvoiceAccountResult> => {
  const envelope = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: { userId: true, teamId: true, status: true, deletedAt: true, revalleInvoice: true },
  });

  const row = envelope?.revalleInvoice;

  if (!envelope || envelope.deletedAt || !row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Nota fiscal não encontrada.' });
  }

  if (envelope.status !== DocumentStatus.DRAFT) {
    if (row.financeStatus === RevalleFinanceStatus.APPROVED && !row.choiceDefer && row.choiceCode === code) {
      return { sent: false };
    }

    throw notAwaitingError();
  }

  const now = new Date();

  if (row.financeStatus === RevalleFinanceStatus.APPROVED && !isStaleLease(row, now)) {
    throw inProgressError();
  }

  if (
    row.financeStatus !== RevalleFinanceStatus.AWAITING_ACCOUNT &&
    row.financeStatus !== RevalleFinanceStatus.APPROVED
  ) {
    throw notAwaitingError();
  }

  const account = await prisma.revalleAccountingAccount.findUnique({
    where: { code },
    select: { code: true, name: true, active: true },
  });

  if (!account?.active) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'Conta contábil inativa ou inexistente.' });
  }

  const { suggestion } = await toInvoiceState(row);

  // Condicionada ao que foi lido: retida (aguardando a conta) ou a reserva vencida que foi lida (a mesma `approvedAt`).
  const claimWhere =
    row.financeStatus === RevalleFinanceStatus.AWAITING_ACCOUNT
      ? { financeStatus: RevalleFinanceStatus.AWAITING_ACCOUNT, choiceDefer: true }
      : { financeStatus: RevalleFinanceStatus.APPROVED, approvedAt: row.approvedAt };

  const { count } = await prisma.revalleInvoiceClassification.updateMany({
    where: { envelopeId, isInvoice: RevalleInvoiceStatus.YES, fileSha256: row.fileSha256, ...claimWhere },
    data: {
      choiceCode: code,
      choiceDefer: false,
      choiceById: user.id,
      choiceAt: now,
      acceptedSuggestion: suggestion ? suggestion.accountCode === code : null,
      financeStatus: RevalleFinanceStatus.APPROVED,
      approvedById: user.id,
      approvedAt: now,
    },
  });

  if (count === 0) {
    // Outro pedido venceu: já enviou (mesma conta = nada a fazer) ou ainda está enviando.
    const current = await prisma.envelope.findUnique({ where: { id: envelopeId }, select: { status: true } });

    if (current?.status === DocumentStatus.DRAFT) {
      throw inProgressError();
    }

    const latest = await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } });

    if (latest?.financeStatus === RevalleFinanceStatus.APPROVED && latest.choiceCode === code) {
      return { sent: false };
    }

    throw notAwaitingError();
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
      // Só desfaz a própria reserva (a mesma `approvedAt`): o estado volta a ser o de uma NF retida.
      await prisma.revalleInvoiceClassification.updateMany({
        where: { envelopeId, financeStatus: RevalleFinanceStatus.APPROVED, approvedAt: now },
        data: {
          choiceCode: null,
          choiceDefer: true,
          choiceById: row.choiceById,
          choiceAt: row.choiceAt,
          acceptedSuggestion: null,
          financeStatus: RevalleFinanceStatus.AWAITING_ACCOUNT,
          approvedById: null,
          approvedAt: null,
        },
      });

      throw error;
    }

    // Já saiu (o erro veio depois da distribuição, ex.: um webhook): a definição vale e vai para o log.
    logger.warn({ msg: 'revalle finance: erro depois do envio da NF definida', envelopeId, error: String(error) });
  }

  // Depois do envio: o evento só existe se o documento saiu. Falhar aqui não desfaz o envio nem vira erro.
  try {
    await prisma.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_FINANCE_ACCOUNT_DEFINED,
        envelopeId,
        data: { code: account.code, name: account.name },
        user,
        requestMetadata: requestMetadata.requestMetadata,
      }),
    });
  } catch (error) {
    logger.warn({ msg: 'revalle finance: falha ao registrar a definição da conta', envelopeId, error: String(error) });
  }

  return { sent: true };
};
