import { prisma } from '@documenso/prisma';
import {
  DocumentStatus,
  RecipientRole,
  RevalleFinanceStatus,
  RevalleInvoiceStatus,
  SigningStatus,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { jobs } from '../../../jobs/client';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { mapSecondaryIdToDocumentId } from '../../../utils/envelope';
import { emailAccountingIfCompleted } from '../invoice/accounting-email';
import { toInvoiceState } from '../invoice/classify';

export type ApproveInvoiceAccountResult = { approved: boolean };

const NOT_PENDING_MESSAGE = 'Esta nota fiscal não está aguardando a aprovação do Financeiro.';
const AWAITING_ACCOUNT_MESSAGE = 'Esta nota fiscal ainda não tem conta: use "Definir conta e enviar".';
const NO_ACCOUNT_MESSAGE = 'Esta nota fiscal ainda não tem conta contábil: escolha a conta e use "Definir e aprovar".';
const NOT_SENT_MESSAGE = 'Só uma nota fiscal enviada (pendente ou concluída) pode ser aprovada.';
const HAS_ACCOUNT_MESSAGE = 'Esta nota fiscal já tem conta: aprove-a ou use "Trocar conta".';
const INACTIVE_ACCOUNT_MESSAGE = 'Conta contábil inativa ou inexistente.';
const STATE_CHANGED_MESSAGE = 'A situação desta nota mudou. Atualize a página e tente de novo.';

const invalid = (message: string) => new AppError(AppErrorCode.INVALID_REQUEST, { message, userMessage: message });

/**
 * "Aprovar conta": o Financeiro confirma a conta escolhida pelo remetente (o membro já foi conferido pela rota).
 *
 * - Só de `PENDING_APPROVAL`, numa gravação condicionada a esse estado e à conta lida, na mesma transação do evento
 *   `REVALLE_FINANCE_APPROVED`: dois cliques ao mesmo tempo aprovam (e registram) uma vez; o outro recebe
 *   `{ approved: false }`, assim como qualquer repetição numa NF já aprovada.
 * - Documento pendente com todos os destinatários atuantes concluídos: dispara a selagem (que estava retida). Se ainda
 *   falta alguém, nada é disparado: a conclusão do último já não fica retida e sela.
 * - Documento já concluído (NF marcada depois da conclusão): a contabilidade recebe o e-mail que estava esperando a
 *   aprovação.
 * - "Definir e aprovar" (`code`): NF marcada depois do envio que ainda não tem conta. Ninguém viu conta nenhuma ao
 *   assinar, então o Financeiro escolhe e aprova no mesmo ato, sem nova versão e sem assinar de novo (evento
 *   `REVALLE_FINANCE_ACCOUNT_DEFINED`). Se a NF já tem conta, `code` só vale igual a ela (é a aprovação).
 */
export const approveInvoiceAccount = async ({
  envelopeId,
  code: definedCode,
  user,
  requestMetadata,
}: {
  envelopeId: string;
  code?: string;
  user: { id: number; name: string | null; email: string };
  requestMetadata: ApiRequestMetadata;
}): Promise<ApproveInvoiceAccountResult> => {
  const envelope = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: { status: true, deletedAt: true, secondaryId: true, revalleInvoice: true },
  });

  const row = envelope?.revalleInvoice;

  if (!envelope || envelope.deletedAt || !row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Nota fiscal não encontrada.' });
  }

  if (row.financeStatus === RevalleFinanceStatus.APPROVED && envelope.status !== DocumentStatus.DRAFT) {
    return { approved: false };
  }

  if (row.financeStatus === RevalleFinanceStatus.AWAITING_ACCOUNT) {
    throw invalid(AWAITING_ACCOUNT_MESSAGE);
  }

  if (row.financeStatus !== RevalleFinanceStatus.PENDING_APPROVAL) {
    throw invalid(NOT_PENDING_MESSAGE);
  }

  if (envelope.status !== DocumentStatus.PENDING && envelope.status !== DocumentStatus.COMPLETED) {
    throw invalid(NOT_SENT_MESSAGE);
  }

  if (!row.choiceCode || row.choiceDefer) {
    if (!definedCode || row.choiceDefer) {
      throw invalid(NO_ACCOUNT_MESSAGE);
    }

    const defined = await defineSentInvoiceAccount({ envelopeId, code: definedCode, user, requestMetadata });

    if (defined) {
      await releaseHeldSeal({ envelopeId, secondaryId: envelope.secondaryId, requestMetadata });
    }

    return { approved: defined };
  }

  if (definedCode && definedCode !== row.choiceCode) {
    throw invalid(HAS_ACCOUNT_MESSAGE);
  }

  const code = row.choiceCode;
  const account = await prisma.revalleAccountingAccount.findUnique({ where: { code }, select: { name: true } });

  const approved = await prisma.$transaction(async (tx) => {
    const { count } = await tx.revalleInvoiceClassification.updateMany({
      where: {
        envelopeId,
        isInvoice: RevalleInvoiceStatus.YES,
        financeStatus: RevalleFinanceStatus.PENDING_APPROVAL,
        choiceCode: code,
        choiceDefer: false,
      },
      data: {
        financeStatus: RevalleFinanceStatus.APPROVED,
        approvedById: user.id,
        approvedAt: new Date(),
        approvedAccountName: account?.name ?? null,
        approvedByName: user.name?.trim() || null,
      },
    });

    if (count === 0) {
      return false;
    }

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_FINANCE_APPROVED,
        envelopeId,
        data: { code, name: account?.name ?? null },
        user,
        requestMetadata: requestMetadata.requestMetadata,
      }),
    });

    return true;
  });

  if (!approved) {
    // Outro pedido aprovou no meio (repetição); qualquer outra mudança (ex.: conta trocada) não é aprovação desta conta.
    const latest = await prisma.revalleInvoiceClassification.findUnique({
      where: { envelopeId },
      select: { financeStatus: true, choiceCode: true },
    });

    if (latest?.financeStatus === RevalleFinanceStatus.APPROVED && latest.choiceCode === code) {
      return { approved: false };
    }

    throw invalid(NOT_PENDING_MESSAGE);
  }

  await releaseHeldSeal({ envelopeId, secondaryId: envelope.secondaryId, requestMetadata });

  return { approved: true };
};

/**
 * "Definir e aprovar": grava a conta (como escolha do Financeiro) e a aprovação numa gravação condicionada a "ainda sem
 * conta", junto com o evento. `false` = outro pedido gravou a mesma conta antes (repetição); qualquer outra mudança no
 * meio é um 400 para atualizar a página.
 */
const defineSentInvoiceAccount = async ({
  envelopeId,
  code,
  user,
  requestMetadata,
}: {
  envelopeId: string;
  code: string;
  user: { id: number; name: string | null; email: string };
  requestMetadata: ApiRequestMetadata;
}) => {
  const account = await prisma.revalleAccountingAccount.findUnique({
    where: { code },
    select: { name: true, active: true },
  });

  if (!account?.active) {
    throw invalid(INACTIVE_ACCOUNT_MESSAGE);
  }

  const row = await prisma.revalleInvoiceClassification.findUniqueOrThrow({ where: { envelopeId } });
  const { suggestion } = await toInvoiceState(row);
  const now = new Date();

  const defined = await prisma.$transaction(async (tx) => {
    const { count } = await tx.revalleInvoiceClassification.updateMany({
      where: {
        envelopeId,
        isInvoice: RevalleInvoiceStatus.YES,
        financeStatus: RevalleFinanceStatus.PENDING_APPROVAL,
        choiceCode: null,
        choiceDefer: false,
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
        approvedAccountName: account.name,
        approvedByName: user.name?.trim() || null,
      },
    });

    if (count === 0) {
      return false;
    }

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_FINANCE_ACCOUNT_DEFINED,
        envelopeId,
        data: { code, name: account.name },
        user,
        requestMetadata: requestMetadata.requestMetadata,
      }),
    });

    return true;
  });

  if (defined) {
    return true;
  }

  const latest = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { financeStatus: true, choiceCode: true },
  });

  if (latest?.financeStatus === RevalleFinanceStatus.APPROVED && latest.choiceCode === code) {
    return false;
  }

  throw invalid(STATE_CHANGED_MESSAGE);
};

/**
 * Depois da aprovação, a NF segue como qualquer documento: pendente com todos concluídos é selada agora; concluída
 * avisa a contabilidade. Status relido aqui: a conclusão do último signatário pode ter chegado durante a aprovação.
 */
const releaseHeldSeal = async ({
  envelopeId,
  secondaryId,
  requestMetadata,
}: {
  envelopeId: string;
  secondaryId: string;
  requestMetadata: ApiRequestMetadata;
}) => {
  const current = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: { status: true, recipients: { select: { role: true, signingStatus: true } } },
  });

  if (!current) {
    return;
  }

  if (current.status === DocumentStatus.COMPLETED) {
    await emailAccountingIfCompleted(envelopeId);

    return;
  }

  const haveAllRecipientsSigned =
    current.status === DocumentStatus.PENDING &&
    current.recipients.length > 0 &&
    current.recipients.every(
      (recipient) => recipient.role === RecipientRole.CC || recipient.signingStatus === SigningStatus.SIGNED,
    );

  if (haveAllRecipientsSigned) {
    await jobs.triggerJob({
      name: 'internal.seal-document',
      payload: {
        documentId: mapSecondaryIdToDocumentId(secondaryId),
        requestMetadata: requestMetadata.requestMetadata,
      },
    });
  }
};
