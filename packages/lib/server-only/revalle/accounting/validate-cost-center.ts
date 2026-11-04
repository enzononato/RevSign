import { prisma } from '@documenso/prisma';
import {
  DocumentStatus,
  EnvelopeType,
  RevalleFinanceStatus,
  RevalleInvoiceStatus,
  SigningStatus,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { isCostCenterCode } from '../../../revalle/invoice/cost-centers';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';

type AccountingUser = { id: number; name: string | null; email: string };

const SUPERSEDED_MESSAGE = 'Esta versão da nota fiscal já foi substituída: use a versão nova.';
const NOT_SENT_MESSAGE = 'Só dá para fazer isso numa nota fiscal enviada ou concluída.';
const REJECTED_MESSAGE = 'Este documento foi recusado: não há centro de custo para acompanhar.';
const NO_COST_CENTER_MESSAGE = 'Esta nota fiscal ainda não tem centro de custo.';
const HAS_COST_CENTER_MESSAGE = 'Esta nota fiscal já tem centro de custo: use "Corrigir centro de custo".';
const UNKNOWN_COST_CENTER_MESSAGE = 'Centro de custo inexistente.';
const STATE_CHANGED_MESSAGE = 'A situação desta nota mudou. Atualize a página e tente de novo.';

const invalid = (message: string) => new AppError(AppErrorCode.INVALID_REQUEST, { message, userMessage: message });

/** A NF em que a Contabilidade pode agir sem nova versão: enviada ou concluída, não substituída, ninguém recusou. */
const loadActionableInvoice = async (envelopeId: string) => {
  const envelope = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: {
      type: true,
      status: true,
      deletedAt: true,
      recipients: { where: { signingStatus: SigningStatus.REJECTED }, select: { id: true }, take: 1 },
      revalleInvoice: true,
    },
  });

  const row = envelope?.revalleInvoice;

  if (!envelope || envelope.type !== EnvelopeType.DOCUMENT || !row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Nota fiscal não encontrada.' });
  }

  // Antes da exclusão: a versão pendente substituída fica escondida como excluída.
  if (row.financeStatus === RevalleFinanceStatus.SUPERSEDED) {
    throw invalid(SUPERSEDED_MESSAGE);
  }

  if (envelope.deletedAt) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Nota fiscal não encontrada.' });
  }

  if (envelope.status === DocumentStatus.REJECTED || envelope.recipients.length > 0) {
    throw invalid(REJECTED_MESSAGE);
  }

  if (envelope.status !== DocumentStatus.PENDING && envelope.status !== DocumentStatus.COMPLETED) {
    throw invalid(NOT_SENT_MESSAGE);
  }

  return row;
};

/**
 * "Validar centro de custo": a qualquer momento depois do envio, antes ou depois do Financeiro (o membro já foi conferido
 * pela rota). Registra quem e quando, com o nome congelado. Não segura a conclusão. Repetir não faz nada: quem validou
 * primeiro fica, e a resposta é `{ validated: false }`.
 *
 * A gravação é condicionada ao centro lido e a "não substituída": com a marca de uma nova versão no meio, a validação
 * perde; se a validação vem antes, a marca é que recomeça (ela também confere a validação lida).
 */
export const validateInvoiceCostCenter = async ({
  envelopeId,
  user,
  requestMetadata,
}: {
  envelopeId: string;
  user: AccountingUser;
  requestMetadata: ApiRequestMetadata;
}): Promise<{ validated: boolean }> => {
  const row = await loadActionableInvoice(envelopeId);
  const code = row.costCenterCode;

  if (!code) {
    throw invalid(NO_COST_CENTER_MESSAGE);
  }

  if (row.costCenterValidatedAt) {
    return { validated: false };
  }

  const validated = await prisma.$transaction(async (tx) => {
    const { count } = await tx.revalleInvoiceClassification.updateMany({
      where: {
        envelopeId,
        isInvoice: RevalleInvoiceStatus.YES,
        costCenterCode: code,
        costCenterValidatedAt: null,
        financeStatus: { not: RevalleFinanceStatus.SUPERSEDED },
      },
      data: {
        costCenterValidatedAt: new Date(),
        costCenterValidatedById: user.id,
        costCenterValidatedByName: user.name?.trim() || null,
      },
    });

    if (count === 0) {
      return false;
    }

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_COST_CENTER_VALIDATED,
        envelopeId,
        data: { code },
        user,
        requestMetadata: requestMetadata.requestMetadata,
      }),
    });

    return true;
  });

  if (validated) {
    return { validated: true };
  }

  const latest = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { financeStatus: true, costCenterCode: true, costCenterValidatedAt: true },
  });

  if (latest?.financeStatus === RevalleFinanceStatus.SUPERSEDED) {
    throw invalid(SUPERSEDED_MESSAGE);
  }

  // Dois cliques ao mesmo tempo: o outro já validou este centro.
  if (latest?.costCenterCode === code && latest.costCenterValidatedAt) {
    return { validated: false };
  }

  throw invalid(STATE_CHANGED_MESSAGE);
};

/**
 * "Definir centro de custo": NF enviada sem centro (marcada depois do envio ou de antes da Fase 7). Ninguém viu centro ao
 * assinar, então não há nova versão, e como foi a Contabilidade que escolheu, ele já fica validado no mesmo ato. Com
 * centro já escolhido, a Contabilidade valida ou corrige.
 */
export const defineInvoiceCostCenter = async ({
  envelopeId,
  code,
  user,
  requestMetadata,
}: {
  envelopeId: string;
  code: string;
  user: AccountingUser;
  requestMetadata: ApiRequestMetadata;
}): Promise<void> => {
  if (!isCostCenterCode(code)) {
    throw invalid(UNKNOWN_COST_CENTER_MESSAGE);
  }

  const row = await loadActionableInvoice(envelopeId);

  if (row.costCenterCode) {
    throw invalid(HAS_COST_CENTER_MESSAGE);
  }

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.revalleInvoiceClassification.updateMany({
      where: {
        envelopeId,
        isInvoice: RevalleInvoiceStatus.YES,
        costCenterCode: null,
        financeStatus: { not: RevalleFinanceStatus.SUPERSEDED },
      },
      data: {
        costCenterCode: code,
        costCenterById: user.id,
        costCenterAt: now,
        costCenterValidatedAt: now,
        costCenterValidatedById: user.id,
        costCenterValidatedByName: user.name?.trim() || null,
      },
    });

    if (count === 0) {
      throw invalid(STATE_CHANGED_MESSAGE);
    }

    for (const log of [
      createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_INVOICE_COST_CENTER_SET,
        envelopeId,
        data: { fromCode: null, toCode: code },
        user,
        requestMetadata: requestMetadata.requestMetadata,
      }),
      createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_COST_CENTER_VALIDATED,
        envelopeId,
        data: { code },
        user,
        requestMetadata: requestMetadata.requestMetadata,
      }),
    ]) {
      await tx.documentAuditLog.create({ data: log });
    }
  });
};
