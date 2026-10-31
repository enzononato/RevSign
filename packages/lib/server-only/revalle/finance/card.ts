import { prisma } from '@documenso/prisma';
import {
  DocumentStatus,
  type RevalleFinanceStatus,
  RevalleInvoiceStatus,
  RevalleSuggestionStatus,
  SigningStatus,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';

export type FinanceCard = {
  envelopeId: string;
  envelopeStatus: DocumentStatus;
  financeStatus: RevalleFinanceStatus | null;
  /** Conta atual (nome atual da lista; a conta já aprovada mostra o nome congelado na aprovação). */
  account: { code: string; name: string | null } | null;
  deferred: boolean;
  /** Quem escolheu a conta (nome, ou e-mail sem nome) e quando. */
  choiceBy: string | null;
  choiceAt: Date | null;
  suggestion: { code: string; name: string | null; confidence: string; reason: string } | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  version: number;
  previousEnvelopeId: string | null;
  supersededByEnvelopeId: string | null;
  supersedeReason: string | null;
  /** Alguém recusou: a NF não aguarda mais nada do Financeiro. */
  rejected: boolean;
};

const userLabel = async (userId: number | null) => {
  if (!userId) {
    return null;
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });

  return user ? user.name?.trim() || user.email : null;
};

const readSuggestion = (status: RevalleSuggestionStatus, stored: unknown) => {
  if (status !== RevalleSuggestionStatus.DONE || !stored || typeof stored !== 'object') {
    return null;
  }

  const { accountCode, confidence, reason } = stored as Record<string, unknown>;

  return typeof accountCode === 'string' && typeof confidence === 'string'
    ? { code: accountCode, confidence, reason: typeof reason === 'string' ? reason : '' }
    : null;
};

/**
 * Cartão "Financeiro" da página da NF (só para membros; a rota confere). Mostra o que o Financeiro precisa para decidir:
 * a conta atual, quem escolheu, a sugestão da IA e o estado. NF excluída pelo remetente não aparece (404), salvo a
 * versão substituída escondida pela troca.
 */
export const getFinanceCard = async (envelopeId: string): Promise<FinanceCard> => {
  const envelope = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: {
      id: true,
      status: true,
      deletedAt: true,
      recipients: { where: { signingStatus: SigningStatus.REJECTED }, select: { id: true }, take: 1 },
      revalleInvoice: true,
    },
  });

  const row = envelope?.revalleInvoice;

  if (!envelope || !row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Nota fiscal não encontrada.' });
  }

  const hiddenSuperseded = row.financeStatus === 'SUPERSEDED' && envelope.status !== DocumentStatus.COMPLETED;

  if (envelope.deletedAt && !hiddenSuperseded) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Nota fiscal não encontrada.' });
  }

  const suggestion = readSuggestion(row.suggestionStatus, row.suggestion);
  const code = row.choiceDefer ? null : row.choiceCode;
  const codes = [code, suggestion?.code].filter((value): value is string => Boolean(value));
  const names = new Map(
    codes.length > 0
      ? (
          await prisma.revalleAccountingAccount.findMany({
            where: { code: { in: codes } },
            select: { code: true, name: true },
          })
        ).map((account) => [account.code, account.name])
      : [],
  );

  const [choiceBy, approvedBy] = await Promise.all([userLabel(row.choiceById), userLabel(row.approvedById)]);

  return {
    envelopeId: envelope.id,
    envelopeStatus: envelope.status,
    financeStatus: row.financeStatus,
    account: code ? { code, name: (row.approvedAt && row.approvedAccountName) || names.get(code) || null } : null,
    deferred: row.choiceDefer,
    choiceBy,
    choiceAt: row.choiceAt,
    suggestion: suggestion ? { ...suggestion, name: names.get(suggestion.code) ?? null } : null,
    approvedBy,
    approvedAt: row.approvedAt,
    version: row.version,
    previousEnvelopeId: row.previousEnvelopeId,
    supersededByEnvelopeId: row.supersededByEnvelopeId,
    supersedeReason: row.supersedeReason,
    rejected: envelope.recipients.length > 0,
  };
};
