import { prisma } from '@documenso/prisma';
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

/**
 * "Deixar para o Financeiro": quem é do Financeiro define a conta da NF retida (`AWAITING_ACCOUNT`). A conta já vale
 * como aprovada (`APPROVED`, com quem e quando), e o documento é enviado em nome do dono (`sendDocument` com o
 * usuário e o time dele; como a escolha não é mais "deixar", o envio não fica retido de novo). O membro já foi
 * conferido pela rota.
 *
 * Idempotente: a gravação é condicionada a `AWAITING_ACCOUNT`; quem chega depois (clique duplo, repetição) não grava,
 * não envia e recebe `{ sent: false }`. A mesma conta numa NF já definida também é `{ sent: false }`; outra conta é
 * troca (outra rota). Se o envio falhar com o documento ainda em rascunho, a NF volta a aguardar a conta.
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

  if (row.financeStatus === RevalleFinanceStatus.APPROVED && !row.choiceDefer && row.choiceCode === code) {
    return { sent: false };
  }

  if (row.financeStatus !== RevalleFinanceStatus.AWAITING_ACCOUNT || envelope.status !== DocumentStatus.DRAFT) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: NOT_AWAITING_MESSAGE,
      userMessage: NOT_AWAITING_MESSAGE,
    });
  }

  const account = await prisma.revalleAccountingAccount.findUnique({
    where: { code },
    select: { code: true, name: true, active: true },
  });

  if (!account?.active) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'Conta contábil inativa ou inexistente.' });
  }

  const { suggestion } = await toInvoiceState(row);
  const now = new Date();

  const { count } = await prisma.revalleInvoiceClassification.updateMany({
    where: {
      envelopeId,
      isInvoice: RevalleInvoiceStatus.YES,
      financeStatus: RevalleFinanceStatus.AWAITING_ACCOUNT,
      choiceDefer: true,
      fileSha256: row.fileSha256,
    },
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
    return { sent: false };
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
      await prisma.revalleInvoiceClassification.updateMany({
        where: { envelopeId, financeStatus: RevalleFinanceStatus.APPROVED, choiceCode: code, approvedAt: now },
        data: {
          choiceCode: null,
          choiceDefer: true,
          choiceById: row.choiceById,
          choiceAt: row.choiceAt,
          acceptedSuggestion: row.acceptedSuggestion,
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

  // Depois do envio: o evento só existe se o documento saiu.
  await prisma.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_FINANCE_ACCOUNT_DEFINED,
      envelopeId,
      data: { code: account.code, name: account.name },
      user,
      requestMetadata: requestMetadata.requestMetadata,
    }),
  });

  return { sent: true };
};
