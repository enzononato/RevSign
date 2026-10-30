import { prisma } from '@documenso/prisma';
import { RevalleInvoiceStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { isAdmin } from '../../../utils/is-admin';
import type { InvoiceState } from './classify';
import { classifyEnvelope, getInvoiceState, isEnvelopeDraft, toInvoiceState } from './classify';

export const INVOICE_ACCOUNT_REQUIRED_MESSAGE = 'Escolha a conta contábil ou deixe para a contabilidade decidir.';

/** Modelo e envio em lote: o documento é criado, mas o envio da nota fiscal espera a conta. */
export const INVOICE_DRAFT_CREATED_MESSAGE =
  'O documento foi criado como rascunho, mas é uma nota fiscal: abra o rascunho, escolha a conta contábil e envie.';

export type InvoiceChoice = { code: string } | { defer: true };

/**
 * Conferência do envio (`sendDocument`), só no primeiro envio (rascunho). Classifica na hora se ainda não foi
 * (cliente da API que envia logo depois de criar): só a detecção, sem esperar a IA. NF sem escolha → recusa.
 */
export const assertInvoiceChoiceBeforeSend = async (envelopeId: string) => {
  const state = await classifyEnvelope(envelopeId, {}, { startSuggestion: false });

  if (state.isInvoice === 'YES' && !state.choice) {
    throw new AppError('INVOICE_ACCOUNT_REQUIRED', {
      message: INVOICE_ACCOUNT_REQUIRED_MESSAGE,
      userMessage: INVOICE_ACCOUNT_REQUIRED_MESSAGE,
      statusCode: 400,
    });
  }
};

const sameChoice = (state: InvoiceState, choice: InvoiceChoice) =>
  'defer' in choice ? state.choice?.code === 'DEFER' : state.choice?.code === choice.code;

/**
 * Grava a conta escolhida (só conta ativa) ou "Deixar para a contabilidade decidir", com quem e quando, e registra
 * no log de auditoria (de → para). `acceptedSuggestion`: se havia sugestão, se a escolha é a conta sugerida; sem
 * sugestão, vazio. No rascunho, quem acessa o documento; depois do envio (inclusive concluído), só o dono e o admin.
 * A mesma escolha de novo não grava nada.
 */
export const setInvoiceChoice = async ({
  envelopeId,
  choice,
  user,
  requestMetadata,
}: {
  envelopeId: string;
  choice: InvoiceChoice;
  user: { id: number; name: string | null; email: string };
  requestMetadata?: RequestMetadata;
}): Promise<InvoiceState> => {
  const isDraft = await isEnvelopeDraft(envelopeId);

  if (!isDraft) {
    const [envelope, account] = await Promise.all([
      prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId }, select: { userId: true } }),
      prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { roles: true } }),
    ]);

    if (envelope.userId !== user.id && !isAdmin(account)) {
      throw new AppError(AppErrorCode.FORBIDDEN, {
        message: 'Depois do envio, só o dono do documento ou o administrador troca a conta.',
      });
    }
  }

  // No rascunho, garante a classificação dos arquivos atuais (a escolha vale para eles). Depois, UMA leitura da
  // linha dá o estado (sugestão) e a condição da gravação: as duas valem para a mesma versão.
  if (isDraft) {
    await classifyEnvelope(envelopeId, { userId: user.id });
  }

  const row = await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } });
  const state = row ? await toInvoiceState(row) : null;

  if (!row || !state || state.isInvoice !== 'YES') {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'O documento não está marcado como nota fiscal.' });
  }

  if ('code' in choice) {
    const account = await prisma.revalleAccountingAccount.findUnique({
      where: { code: choice.code },
      select: { active: true },
    });

    if (!account?.active) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'Conta contábil inativa ou inexistente.' });
    }
  }

  if (sameChoice(state, choice)) {
    return state;
  }

  const toCode = 'code' in choice ? choice.code : null;
  const toDefer = 'defer' in choice;

  await prisma.$transaction(async (tx) => {
    // Condicionada ao que foi lido: se os arquivos mudaram (ou outra escolha entrou) no meio, nada é gravado.
    const { count } = await tx.revalleInvoiceClassification.updateMany({
      where: {
        envelopeId,
        isInvoice: RevalleInvoiceStatus.YES,
        fileSha256: row.fileSha256,
        choiceCode: row.choiceCode,
        choiceDefer: row.choiceDefer,
      },
      data: {
        choiceCode: toCode,
        choiceDefer: toDefer,
        choiceById: user.id,
        choiceAt: new Date(),
        acceptedSuggestion: state.suggestion ? toCode === state.suggestion.accountCode : null,
      },
    });

    if (count === 0) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'O documento mudou enquanto a conta era escolhida. Tente de novo.',
      });
    }

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_INVOICE_ACCOUNT_SET,
        envelopeId,
        data: { fromCode: row.choiceCode, fromDefer: row.choiceDefer, toCode, toDefer },
        user,
        requestMetadata,
      }),
    });
  });

  return await getInvoiceState(envelopeId);
};
