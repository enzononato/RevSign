import { prisma } from '@documenso/prisma';
import type { RevalleInvoiceFile } from '@prisma/client';
import {
  DocumentStatus,
  type RevalleFinanceStatus,
  RevalleInvoiceFileKind,
  RevalleInvoiceStatus,
  RevalleSuggestionStatus,
  type RevalleSupersedeKind,
  SigningStatus,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { isNewVersionDraftRow } from '../../../revalle/finance/finance-status';
import { costCenterLabel } from '../../../revalle/invoice/cost-centers';
import { fileFinanceStatus, type InvoicePosition, invoicePositions } from '../../../revalle/invoice/invoice-files';
import { loadInvoiceFiles, refreshLegacyInvoiceFiles, resolveInvoiceFile } from '../invoice/invoice-files';
import { findVisibleSuccessor, isStaleChangeClaim } from './successor';

export type FinanceCard = {
  envelopeId: string;
  /** Fase 9: a nota do cartão (o arquivo), com o título e a posição entre as notas do envio. */
  envelopeItemId: string;
  documentTitle: string;
  position: InvoicePosition;
  envelopeStatus: DocumentStatus;
  /** A situação da nota (`fileFinanceStatus`): com várias notas, a já aprovada fica aprovada enquanto o envio aguarda. */
  financeStatus: RevalleFinanceStatus | null;
  /** Conta atual (nome atual da lista; a conta já aprovada mostra o nome congelado na aprovação). */
  account: { code: string; name: string | null } | null;
  /** Centro de custo ("101 – Puxada"), em leitura: quem corrige é a Contabilidade. */
  costCenterLabel: string | null;
  /** Quem escolheu a conta (nome, ou e-mail sem nome) e quando. */
  choiceBy: string | null;
  choiceAt: Date | null;
  suggestion: { code: string; name: string | null; confidence: string; reason: string } | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  version: number;
  previousEnvelopeId: string | null;
  /** A nova versão, só quando ela existe e abre na página da NF (o link não leva a um 404). */
  supersededByEnvelopeId: string | null;
  supersedeReason: string | null;
  supersedeKind: RevalleSupersedeKind | null;
  /** Versão substituída cuja nova versão não existe mais (ou a troca morreu no meio): "Trocar conta" de novo. */
  canRetakeChange: boolean;
  /** Alguém recusou: a NF não aguarda mais nada do Financeiro. */
  rejected: boolean;
};

export const userLabel = async (userId: number | null) => {
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

/** As colunas "da nota" que os cartões do Financeiro e da Contabilidade leem. */
export type CardNoteColumns = Pick<
  RevalleInvoiceFile,
  | 'suggestionStatus'
  | 'suggestion'
  | 'choiceCode'
  | 'choiceById'
  | 'choiceAt'
  | 'costCenterCode'
  | 'costCenterValidatedAt'
  | 'costCenterValidatedById'
  | 'costCenterValidatedByName'
  | 'approvedById'
  | 'approvedAt'
  | 'approvedAccountName'
  | 'approvedByName'
>;

/**
 * Fase 9: a nota de um cartão. Sem `envelopeItemId`, a nota única (com 2+, `INVOICE_FILE_REQUIRED`); com ele, uma NF deste
 * envio (senão 404). Envio sem linha de arquivo nenhuma (rascunho de antes da Fase 9): a linha do envio, como antes, no
 * primeiro arquivo.
 */
export const loadCardNote = async ({
  envelopeId,
  envelopeItemId,
  row,
}: {
  envelopeId: string;
  envelopeItemId: string | undefined;
  row: CardNoteColumns;
}): Promise<{ envelopeItemId: string; documentTitle: string; position: InvoicePosition; note: CardNoteColumns }> => {
  await refreshLegacyInvoiceFiles(envelopeId);

  const files = await loadInvoiceFiles(envelopeId);

  if (!files.some((file) => file.kind === RevalleInvoiceFileKind.NF)) {
    const item = await prisma.envelopeItem.findFirst({
      where: { envelopeId, ...(envelopeItemId !== undefined ? { id: envelopeItemId } : {}) },
      orderBy: { order: 'asc' },
      select: { id: true, title: true },
    });

    if (!item) {
      throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Nota fiscal não encontrada neste envio.' });
    }

    return { envelopeItemId: item.id, documentTitle: item.title, position: { index: 1, total: 1 }, note: row };
  }

  const file = await resolveInvoiceFile({ envelopeId, envelopeItemId });

  return {
    envelopeItemId: file.envelopeItemId,
    documentTitle: file.title,
    position: invoicePositions(files).get(file.id) ?? { index: 1, total: 1 },
    note: file,
  };
};

/**
 * Cartão "Financeiro" da página da NF (só para membros; a rota confere). Mostra o que o Financeiro precisa para decidir:
 * a conta atual, quem escolheu, a sugestão da IA e o estado. Mesmo acesso da página: NF excluída pelo remetente e rascunho
 * comum de outra pessoa dão 404; a versão substituída escondida pela troca e o rascunho de uma nova versão, não.
 *
 * Fase 9: o cartão é de uma nota (`envelopeItemId`, obrigatório com 2+ notas): a conta, quem escolheu, a sugestão e a
 * aprovação são dela; a versão, a ligação e a recusa são do envio.
 */
export const getFinanceCard = async (envelopeId: string, envelopeItemId?: string): Promise<FinanceCard> => {
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

  if (envelope.status === DocumentStatus.DRAFT && !isNewVersionDraftRow(row)) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Nota fiscal não encontrada.' });
  }

  const { note, ...document } = await loadCardNote({ envelopeId, envelopeItemId, row });
  const suggestion = readSuggestion(note.suggestionStatus, note.suggestion);
  const code = note.choiceCode;
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

  const isSuperseded = row.financeStatus === 'SUPERSEDED';
  const [choiceBy, approvedBy, successor, canRetakeChange] = await Promise.all([
    userLabel(note.choiceById),
    note.approvedByName && note.approvedAt ? note.approvedByName : userLabel(note.approvedById),
    isSuperseded ? findVisibleSuccessor(row.supersededByEnvelopeId) : null,
    isStaleChangeClaim(row, new Date()),
  ]);

  return {
    envelopeId: envelope.id,
    ...document,
    envelopeStatus: envelope.status,
    financeStatus: fileFinanceStatus(row.financeStatus, note.approvedAt),
    account: code ? { code, name: (note.approvedAt && note.approvedAccountName) || names.get(code) || null } : null,
    costCenterLabel: note.costCenterCode ? costCenterLabel(note.costCenterCode) : null,
    choiceBy,
    choiceAt: note.choiceAt,
    suggestion: suggestion ? { ...suggestion, name: names.get(suggestion.code) ?? null } : null,
    approvedBy,
    approvedAt: note.approvedAt,
    version: row.version,
    previousEnvelopeId: row.previousEnvelopeId,
    supersededByEnvelopeId: successor?.id ?? null,
    supersedeReason: row.supersedeReason,
    supersedeKind: row.supersedeKind,
    canRetakeChange,
    rejected: envelope.recipients.length > 0,
  };
};
