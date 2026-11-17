import { prisma } from '@documenso/prisma';
import type { RevalleInvoiceClassification, RevalleInvoiceFile } from '@prisma/client';
import {
  DocumentStatus,
  Prisma,
  RevalleFinanceStatus,
  RevalleInvoiceDetectedBy,
  RevalleInvoiceFileKind,
  RevalleInvoiceStatus,
  RevalleSuggestionStatus,
  RevalleSupersedeKind,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { isNewVersionDraftRow } from '../../../revalle/finance/finance-status';
import { REVALLE_COST_CENTERS } from '../../../revalle/invoice/cost-centers';
import { extractAccessKeys } from '../../../revalle/invoice/detect-invoice';
import {
  type InvoiceDataSummary,
  NO_INVOICE_DATA_COLUMNS,
  toInvoiceDataSummary,
} from '../../../revalle/invoice/invoice-data';
import {
  aggregateIsInvoice,
  type InvoiceFileKind,
  type InvoicePosition,
  invoicePositions,
} from '../../../revalle/invoice/invoice-files';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { findNewVersionKind, findVisibleSuccessor } from '../finance/successor';
import type { InvoiceDuplicate } from './duplicates';
import { findInvoiceDuplicatesOrEmpty } from './duplicates';
import type { InvoiceEnvelopeFile } from './envelope-files';
import { filesKey, loadEnvelopeFiles, readFilesContent } from './envelope-files';
import type { LoadedInvoiceFile } from './invoice-files';
import {
  ensureLegacyInvoiceFiles,
  loadInvoiceFiles,
  lockInvoiceEnvelope,
  syncInvoiceEnvelopeMirror,
  updateInvoiceFiles,
} from './invoice-files';
import { getRevalleInvoiceAiConfig } from './settings';
import type { InvoiceFailureReason, InvoiceRequester } from './suggest';
import { INVOICE_SUGGESTION_STALE_MS, startInvoiceFileRead } from './suggest';

export type InvoiceState = {
  isInvoice: 'YES' | 'NO' | 'UNKNOWN';
  detectedBy: 'TEXT' | 'SENDER';
  suggestionStatus: 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED';
  suggestion: {
    accountCode: string;
    accountName: string;
    confidence: 'alta' | 'media' | 'baixa';
    reason: string;
  } | null;
  /** Código curto quando `suggestionStatus` é FAILED (nunca texto da NF nem do provedor). */
  failureReason: InvoiceFailureReason | null;
  /**
   * Fase 8: fornecedor, número e valor que a IA leu da NF com a sugestão. Podem estar errados (a tela diz que vieram da
   * IA) e não entram na assinatura. Nulo quando os três estão vazios.
   */
  invoiceData: InvoiceDataSummary | null;
  /**
   * Fase 8: outras NFs vivas com uma chave em comum ou o mesmo arquivo (a tela avisa "Esta nota parece já ter sido
   * enviada"). Só data, remetente e situação: quem vê o estado pode não ter acesso à outra nota, então nada de título nem
   * id. Vazio quando esta NF não está viva (substituída, recusada, cancelada ou excluída) ou não é NF.
   */
  duplicates: Pick<InvoiceDuplicate, 'sentAt' | 'senderName' | 'status'>[];
  choice: { code: string; name?: string } | null;
  /** Fase 7: centro de custo escolhido (lista fixa); a conta e o centro são exigidos juntos no primeiro envio. */
  costCenter: { code: string; name: string } | null;
  /** Fase 6: estado no Financeiro (nulo = não é NF, ou NF em rascunho que ainda não foi enviada). */
  financeStatus: 'PENDING_APPROVAL' | 'APPROVED' | 'SUPERSEDED' | 'LEGACY' | null;
  /**
   * Nova versão em rascunho que quem tem acesso a ela pode enviar (o envio falhou): `APPROVED` sem reserva de envio
   * (`approvedAt` nulo), ou uma correção do centro, que não tem reserva. A conta e o centro continuam travados.
   */
  isFinanceSendReleased: boolean;
  /**
   * Versão substituída: a nova versão (com a conta trocada ou o centro corrigido), para o cartão do remetente apontar.
   * Nula quando a nova versão não existe mais ou foi excluída.
   */
  supersededByEnvelopeId: string | null;
  /** Versão substituída: o que mudou. */
  supersedeKind: RevalleSupersedeKind | null;
  aiAvailable: boolean;
  /**
   * Fase 9: cada arquivo do envio, na ordem dos arquivos, com o tipo e o que é "da nota". Os campos de cima são: com uma
   * nota, os dela (iguais aos de antes da Fase 9); sem nota, os de sempre; com 2+ notas, a situação da IA agregada, a
   * união das duplicadas e o resto nulo (cada nota tem o seu aqui).
   */
  documents: InvoiceDocumentState[];
};

/** Fase 9: um arquivo do envio no estado da nota fiscal. */
export type InvoiceDocumentState = {
  envelopeItemId: string;
  title: string;
  order: number;
  kind: InvoiceFileKind;
  detectedBy: 'TEXT' | 'SENDER';
  /** Só NF: a posição entre as notas do envio (1 de 3...). */
  position: InvoicePosition | null;
  suggestionStatus: 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED';
  suggestion: InvoiceState['suggestion'];
  failureReason: InvoiceFailureReason | null;
  invoiceData: InvoiceDataSummary | null;
  /** Vazio até a Task 4 (duplicada por nota). */
  duplicates: InvoiceState['duplicates'];
  /** Nulo até a Task 4 (a mesma nota duas vezes no envio). */
  duplicateInEnvelope: { index: number } | null;
  choice: InvoiceState['choice'];
  costCenter: InvoiceState['costCenter'];
  /** Task 3 (boleto). */
  boleto: null;
};

type StoredSuggestion = {
  accountCode?: unknown;
  confidence?: unknown;
  reason?: unknown;
  failure?: unknown;
};

const readStored = (value: unknown): StoredSuggestion =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const CONFIDENCES = new Set(['alta', 'media', 'baixa']);

const isSendReleased = async (row: RevalleInvoiceClassification) => {
  if (row.financeStatus === RevalleFinanceStatus.APPROVED && row.approvedAt === null) {
    return true;
  }

  if (!isNewVersionDraftRow(row) || !(await isEnvelopeDraft(row.envelopeId))) {
    return false;
  }

  return (
    row.financeStatus === RevalleFinanceStatus.PENDING_APPROVAL ||
    (await findNewVersionKind(row.previousEnvelopeId)) === RevalleSupersedeKind.COST_CENTER
  );
};

/** O estado sem o aviso de duplicada nem os arquivos: o que quem só precisa da sugestão ou da escolha usa. */
export type InvoiceStateBase = Omit<InvoiceState, 'duplicates' | 'documents'>;

/** As colunas "da nota", iguais na linha do arquivo e no espelho da linha do envio. */
type NoteColumns = Pick<
  RevalleInvoiceFile,
  | 'suggestionStatus'
  | 'suggestion'
  | 'choiceCode'
  | 'costCenterCode'
  | 'supplierName'
  | 'invoiceNumber'
  | 'totalAmountCents'
>;

const storedAccountCode = (row: NoteColumns) => {
  const stored = readStored(row.suggestion);

  return row.suggestionStatus === RevalleSuggestionStatus.DONE &&
    typeof stored.accountCode === 'string' &&
    typeof stored.reason === 'string' &&
    typeof stored.confidence === 'string' &&
    CONFIDENCES.has(stored.confidence)
    ? stored.accountCode
    : null;
};

type AccountLookup = Map<string, { code: string; name: string; active: boolean }>;

/** Nomes das contas da lista (inclusive inativas: documento antigo mostra número e nome). */
const loadAccounts = async (rows: NoteColumns[]): Promise<AccountLookup> => {
  const codes = [
    ...new Set(
      rows.flatMap((row) => [storedAccountCode(row), row.choiceCode]).filter((code): code is string => Boolean(code)),
    ),
  ];

  return new Map(
    codes.length > 0
      ? (
          await prisma.revalleAccountingAccount.findMany({
            where: { code: { in: codes } },
            select: { code: true, name: true, active: true },
          })
        ).map((account) => [account.code, account])
      : [],
  );
};

/** A sugestão, a conta, o centro, a falha e os dados lidos de uma nota (ou do espelho). */
const noteState = (row: NoteColumns, accounts: AccountLookup) => {
  const stored = readStored(row.suggestion);
  const suggestedCode = storedAccountCode(row);
  const suggestedAccount = suggestedCode ? accounts.get(suggestedCode) : undefined;

  // Conta sugerida que saiu da lista (inativa) não é mais oferecida: fica como "sem sugestão".
  const suggestion: InvoiceState['suggestion'] = suggestedAccount?.active
    ? {
        accountCode: suggestedAccount.code,
        accountName: suggestedAccount.name,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        confidence: stored.confidence as 'alta' | 'media' | 'baixa',
        reason: String(stored.reason),
      }
    : null;

  return {
    suggestionStatus: row.suggestionStatus,
    suggestion,
    failureReason:
      row.suggestionStatus === RevalleSuggestionStatus.FAILED && typeof stored.failure === 'string'
        ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          (stored.failure as InvoiceFailureReason)
        : null,
    invoiceData: toInvoiceDataSummary(row),
    choice: row.choiceCode ? { code: row.choiceCode, name: accounts.get(row.choiceCode)?.name } : null,
    costCenter: row.costCenterCode
      ? {
          code: row.costCenterCode,
          name: REVALLE_COST_CENTERS.find((center) => center.code === row.costCenterCode)?.name ?? row.costCenterCode,
        }
      : null,
  };
};

/** A sugestão ainda válida (conta ativa) de uma nota: a escolha a compara para `acceptedSuggestion`. */
export const invoiceFileSuggestion = async (row: NoteColumns): Promise<InvoiceState['suggestion']> =>
  noteState(row, await loadAccounts([row])).suggestion;

/**
 * O estado sem a busca de duplicadas. A aprovação do Financeiro e a nova versão só querem a sugestão: não pagam a consulta
 * e não ganham um ponto de falha. Lê a linha do envio (o espelho: com uma nota, as colunas dela).
 */
export const toInvoiceStateBase = async (row: RevalleInvoiceClassification): Promise<InvoiceStateBase> => {
  const note = noteState(row, await loadAccounts([row]));

  return {
    isInvoice: row.isInvoice,
    detectedBy: row.detectedBy,
    ...note,
    financeStatus: row.financeStatus,
    isFinanceSendReleased: await isSendReleased(row),
    supersededByEnvelopeId:
      row.financeStatus === RevalleFinanceStatus.SUPERSEDED
        ? ((await findVisibleSuccessor(row.supersededByEnvelopeId))?.id ?? null)
        : null,
    supersedeKind: row.financeStatus === RevalleFinanceStatus.SUPERSEDED ? row.supersedeKind : null,
    aiAvailable: getRevalleInvoiceAiConfig().status === 'CONFIGURED',
  };
};

/** Fase 9: os arquivos do envio no estado, na ordem dos arquivos. */
export const toInvoiceDocuments = async (files: LoadedInvoiceFile[]): Promise<InvoiceDocumentState[]> => {
  const accounts = await loadAccounts(files);
  const positions = invoicePositions(files);

  return files.map((file) => ({
    envelopeItemId: file.envelopeItemId,
    title: file.title,
    order: file.order,
    kind: file.kind,
    detectedBy: file.detectedBy,
    position: positions.get(file.id) ?? null,
    ...noteState(file, accounts),
    duplicates: [],
    duplicateInEnvelope: null,
    boleto: null,
  }));
};

/**
 * Monta o estado da tela, com o aviso de nota duplicada. Se a busca de duplicadas falhar, o estado sai sem o aviso (a falha
 * é registrada, sem dados): o alerta não pode derrubar a tela nem o que ela faz.
 */
export const toInvoiceState = async (row: RevalleInvoiceClassification): Promise<InvoiceState> => ({
  ...(await toInvoiceStateBase(row)),
  duplicates:
    row.isInvoice === RevalleInvoiceStatus.YES
      ? (await findInvoiceDuplicatesOrEmpty(row)).map(({ sentAt, senderName, status }) => ({
          sentAt,
          senderName,
          status,
        }))
      : [],
  documents: await toInvoiceDocuments(await loadInvoiceFiles(row.envelopeId)),
});

/**
 * PENDING esquecido (job perdido) vira FAILED/TIMEOUT, para a tela não ficar presa em "Buscando sugestão…". Por arquivo;
 * envio de antes da Fase 9 sem linha de arquivo, na linha do envio (como antes).
 */
const expireStalePending = async (row: RevalleInvoiceClassification) => {
  const { envelopeId } = row;
  const files = await prisma.revalleInvoiceFile.findMany({
    where: { envelopeId, suggestionStatus: RevalleSuggestionStatus.PENDING },
    select: { id: true, updatedAt: true },
  });

  if (files.length === 0) {
    if (
      row.suggestionStatus !== RevalleSuggestionStatus.PENDING ||
      Date.now() - row.updatedAt.getTime() < INVOICE_SUGGESTION_STALE_MS ||
      (await prisma.revalleInvoiceFile.count({ where: { envelopeId } })) > 0
    ) {
      return row;
    }

    await prisma.revalleInvoiceClassification.updateMany({
      where: { envelopeId, suggestionStatus: RevalleSuggestionStatus.PENDING, updatedAt: row.updatedAt },
      data: { suggestionStatus: RevalleSuggestionStatus.FAILED, suggestion: { failure: 'TIMEOUT' } },
    });

    return await prisma.revalleInvoiceClassification.findUniqueOrThrow({ where: { envelopeId } });
  }

  const stale = files.filter((file) => Date.now() - file.updatedAt.getTime() >= INVOICE_SUGGESTION_STALE_MS);

  if (stale.length === 0) {
    return row;
  }

  for (const file of stale) {
    await updateInvoiceFiles({
      envelopeId,
      where: { id: file.id, suggestionStatus: RevalleSuggestionStatus.PENDING, updatedAt: file.updatedAt },
      data: { suggestionStatus: RevalleSuggestionStatus.FAILED, suggestion: { failure: 'TIMEOUT' } },
    });
  }

  return await prisma.revalleInvoiceClassification.findUniqueOrThrow({ where: { envelopeId } });
};

/**
 * Escolha da conta e do centro de custo zerada: ela vale para um conjunto de arquivos (trocou um arquivo, escolhe de novo
 * em todas as notas). A nova versão em rascunho cujo arquivo muda volta a ser um rascunho comum do remetente: a aprovação e
 * a validação eram para outro arquivo. Sem a aprovação na linha, ela também não volta numa retomada
 * (`nextClassification`).
 */
export const CLEARED_FILE_CHOICE = {
  choiceCode: null,
  choiceById: null,
  choiceAt: null,
  acceptedSuggestion: null,
  costCenterCode: null,
  costCenterById: null,
  costCenterAt: null,
  costCenterValidatedAt: null,
  costCenterValidatedById: null,
  costCenterValidatedByName: null,
  approvedById: null,
  approvedAt: null,
  approvedAccountName: null,
  approvedByName: null,
};

/** A IA de um arquivo zerada (o arquivo deixou de ser nota, ou a leitura recomeça). */
const CLEARED_FILE_READ = {
  suggestionStatus: RevalleSuggestionStatus.SKIPPED,
  suggestion: Prisma.DbNull,
  // Fase 8: os dados lidos pela IA eram de outra leitura.
  ...NO_INVOICE_DATA_COLUMNS,
};

/** Documento já enviado que nunca foi classificado (ex.: enviado antes desta versão): não é tratado como NF. */
const unclassifiedState = (): InvoiceState => ({
  isInvoice: 'NO',
  detectedBy: 'TEXT',
  suggestionStatus: 'SKIPPED',
  suggestion: null,
  failureReason: null,
  invoiceData: null,
  duplicates: [],
  choice: null,
  costCenter: null,
  financeStatus: null,
  isFinanceSendReleased: false,
  supersededByEnvelopeId: null,
  supersedeKind: null,
  aiAvailable: getRevalleInvoiceAiConfig().status === 'CONFIGURED',
  documents: [],
});

/** Fase 6: depois do envio, o remetente não troca mais a conta nem a marcação de NF; quem troca é o Financeiro. */
export const INVOICE_FINANCE_DECIDES_MESSAGE = 'Depois do envio, quem troca a conta é o Financeiro.';

export const financeDecidesError = () =>
  new AppError(AppErrorCode.FORBIDDEN, {
    message: INVOICE_FINANCE_DECIDES_MESSAGE,
    userMessage: INVOICE_FINANCE_DECIDES_MESSAGE,
  });

/**
 * Rascunho travado para o dono: uma nova versão, com o envio em andamento ou parado (ver `define-and-send.ts`). A conta e
 * o centro são os que o Financeiro ou a Contabilidade definiram, e a aprovação ou a validação valem para eles. O dono
 * ainda pode trocar o arquivo, que zera tudo e devolve a NF a ele.
 */
export const isDraftFinanceStatusLocked = (
  row: Pick<RevalleInvoiceClassification, 'financeStatus' | 'previousEnvelopeId'> | null | undefined,
) => Boolean(row && (row.financeStatus === RevalleFinanceStatus.APPROVED || isNewVersionDraftRow(row)));

/** O rascunho do envelope está travado para o dono (`isDraftFinanceStatusLocked`): ele não troca a marcação de NF. */
export const isDraftLockedForOwner = async (envelopeId: string) => {
  const row = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { financeStatus: true, previousEnvelopeId: true },
  });

  return isDraftFinanceStatusLocked(row);
};

export const isEnvelopeDraft = async (envelopeId: string) => {
  const envelope = await prisma.envelope.findUnique({ where: { id: envelopeId }, select: { status: true } });

  return envelope?.status === DocumentStatus.DRAFT;
};

/** As linhas de arquivo valem para os arquivos atuais: a chave do conjunto e uma linha por arquivo, com a SHA-256 dele. */
const isUpToDate = (
  envelopeKey: string | null | undefined,
  rows: Array<Pick<RevalleInvoiceFile, 'envelopeItemId' | 'fileSha256'>>,
  files: InvoiceEnvelopeFile[],
  key: string | null,
) =>
  envelopeKey === key &&
  rows.length === files.length &&
  files.every((file) =>
    rows.some((row) => row.envelopeItemId === file.envelopeItemId && row.fileSha256 === file.sha256),
  );

const kindOf = (content: { detection: { status: 'YES' | 'NO' | 'UNKNOWN' }; isSparse: boolean }) =>
  content.detection.status === 'YES'
    ? RevalleInvoiceFileKind.NF
    : content.isSparse
      ? RevalleInvoiceFileKind.UNKNOWN
      : RevalleInvoiceFileKind.OTHER;

/** Fase 9: o arquivo da nota no evento, só com 2+ notas (com uma, o evento é igual ao de antes). */
export const invoiceAuditDocument = (
  file: Pick<LoadedInvoiceFile, 'id' | 'envelopeItemId' | 'title'>,
  positions: Map<string, InvoicePosition>,
) => {
  const position = positions.get(file.id);

  return position && position.total > 1
    ? {
        document: {
          envelopeItemId: file.envelopeItemId,
          title: file.title,
          index: position.index,
          total: position.total,
        },
      }
    : {};
};

/**
 * Refaz as linhas de arquivo de um rascunho quando os arquivos mudaram (ou na primeira vez). Detecta cada arquivo pelo
 * texto (até 5 páginas): NF se o texto é de nota; sem texto (escaneado) fica em dúvida (`UNKNOWN`, o remetente decide);
 * senão "outro". Zera a leitura da IA e a escolha (conta, centro, aprovação, validação) de TODAS as notas, com um evento
 * `FILES_CHANGED` por nota que tinha conta; o envio volta a ser rascunho comum (`financeStatus` nulo).
 *
 * Numa transação com o envio travado e conferida de novo depois da trava: de vários pedidos ao mesmo tempo, o primeiro
 * refaz e os outros encontram as linhas em dia (e não desfazem o trabalho dele, inclusive uma leitura já em andamento).
 */
const refreshDraftInvoiceFiles = async (envelopeId: string, requester: InvoiceRequester) => {
  const row = await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } });
  const files = await loadEnvelopeFiles(envelopeId);
  const key = filesKey(files);

  if (row) {
    let rows = await loadInvoiceFiles(envelopeId);

    if (isUpToDate(row.fileSha256, rows, files, key)) {
      return;
    }

    // Rascunho de antes da Fase 9 com os mesmos arquivos: as linhas são refeitas sem apagar a escolha.
    if (rows.length === 0 && row.fileSha256 === key && row.isInvoice === RevalleInvoiceStatus.YES) {
      await ensureLegacyInvoiceFiles(envelopeId, { allowDraft: true });
      rows = await loadInvoiceFiles(envelopeId);

      if (isUpToDate(row.fileSha256, rows, files, key)) {
        return;
      }
    }
  }

  const contents = await readFilesContent(files);
  const kinds = new Map(contents.map((content) => [content.file.envelopeItemId, kindOf(content)]));
  const envelopeData = {
    isInvoice: aggregateIsInvoice([...kinds.values()]),
    detectedBy: RevalleInvoiceDetectedBy.TEXT,
    signals: [
      ...new Set(
        contents
          .filter((content) => content.detection.status === 'YES')
          .flatMap((content) => content.detection.signals),
      ),
    ],
    fileSha256: key,
  };
  const user =
    requester.userId !== undefined
      ? await prisma.user.findUnique({ where: { id: requester.userId }, select: { id: true, name: true, email: true } })
      : null;

  await prisma.$transaction(async (tx) => {
    const created = row
      ? false
      : (
          await tx.revalleInvoiceClassification.createMany({
            data: [{ envelopeId, ...envelopeData }],
            skipDuplicates: true,
          })
        ).count > 0;

    const locked = await lockInvoiceEnvelope(tx, envelopeId);

    if (!locked) {
      return;
    }

    const previous = await loadInvoiceFiles(envelopeId, tx);

    if (!created && isUpToDate(locked.fileSha256, previous, files, key)) {
      return;
    }

    await tx.revalleInvoiceFile.deleteMany({
      where: { envelopeId, envelopeItemId: { notIn: files.map((file) => file.envelopeItemId) } },
    });

    for (const content of contents) {
      const kind = kinds.get(content.file.envelopeItemId) ?? RevalleInvoiceFileKind.OTHER;
      // Fase 8: as chaves de acesso do alerta de duplicada vêm do texto de cada arquivo (só a chave própria de cada
      // página). Ficam também nos arquivos "outro": se o remetente disser que é nota, já estão lá. Só as das notas vão
      // para o espelho.
      const data = {
        kind,
        detectedBy: RevalleInvoiceDetectedBy.TEXT,
        kindChangedById: null,
        kindChangedAt: null,
        signals: kind === RevalleInvoiceFileKind.NF ? content.detection.signals : [],
        fileSha256: content.file.sha256,
        accessKeys: content.isSparse ? [] : extractAccessKeys(content.pages),
        boletoData: Prisma.DbNull,
        ...CLEARED_FILE_READ,
        ...CLEARED_FILE_CHOICE,
      };

      // A contagem de chamadas à IA do arquivo que continua no envio fica (o limite é por arquivo, para sempre).
      await tx.revalleInvoiceFile.upsert({
        where: { envelopeItemId: content.file.envelopeItemId },
        create: { envelopeId, envelopeItemId: content.file.envelopeItemId, ...data },
        update: data,
      });
    }

    await tx.revalleInvoiceClassification.update({
      where: { envelopeId },
      data: { ...envelopeData, financeStatus: null },
    });

    await syncInvoiceEnvelopeMirror(tx, envelopeId);

    // A escolha apagada pela troca de arquivo também vai para o histórico (sem usuário = o próprio sistema), uma por nota.
    const positions = invoicePositions(previous);

    for (const file of previous) {
      if (file.kind !== RevalleInvoiceFileKind.NF || file.choiceCode === null) {
        continue;
      }

      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_INVOICE_ACCOUNT_SET,
          envelopeId,
          data: {
            fromCode: file.choiceCode,
            toCode: null,
            reason: 'FILES_CHANGED',
            ...invoiceAuditDocument(file, positions),
          },
          user,
          requestMetadata: requester.ipAddress ? { ipAddress: requester.ipAddress } : undefined,
        }),
      });
    }

    // Envio de antes da Fase 9 (sem linha de arquivo) que tinha conta: o evento de sempre.
    if (previous.length === 0 && row?.choiceCode) {
      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_INVOICE_ACCOUNT_SET,
          envelopeId,
          data: { fromCode: row.choiceCode, toCode: null, reason: 'FILES_CHANGED' },
          user,
          requestMetadata: requester.ipAddress ? { ipAddress: requester.ipAddress } : undefined,
        }),
      });
    }
  });
};

/** Começa a leitura de toda nota que ainda não foi lida (SKIPPED): cache, job em segundo plano ou nada (IA desligada). */
const startPendingReads = async (envelopeId: string, requester: InvoiceRequester) => {
  for (const file of await loadInvoiceFiles(envelopeId)) {
    if (file.kind === RevalleInvoiceFileKind.NF && file.suggestionStatus === RevalleSuggestionStatus.SKIPPED) {
      await startInvoiceFileRead({ fileId: file.id, fileSha256: file.fileSha256, requester });
    }
  }
};

/**
 * Classifica o documento (idempotente), arquivo por arquivo (`refreshDraftInvoiceFiles`): se nenhum arquivo mudou desde
 * a última vez, mantém tudo (inclusive as decisões e as escolhas do remetente). O envio é NF se um arquivo for NF; senão,
 * `UNKNOWN` se algum arquivo não tiver texto (escaneado: o remetente decide); senão, `NO`. Cada nota com a IA ligada começa
 * a leitura dela (cache, ou job em segundo plano), salvo `startSuggestion: false`.
 *
 * Só rascunho é (re)classificado: depois do envio a classificação fica congelada. O envio pode trocar o PDF
 * (`formValues` gera outro arquivo) e isso não pode apagar a conta escolhida.
 */
export const classifyEnvelope = async (
  envelopeId: string,
  requester: InvoiceRequester = {},
  { startSuggestion = true }: { startSuggestion?: boolean } = {},
): Promise<InvoiceState> => {
  if (!(await isEnvelopeDraft(envelopeId))) {
    const row = await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } });

    if (!row) {
      return unclassifiedState();
    }

    await ensureLegacyInvoiceFiles(envelopeId);

    return await toInvoiceState(await expireStalePending(row));
  }

  await refreshDraftInvoiceFiles(envelopeId, requester);

  // Também cobre a IA ligada depois da classificação (nota que ficou SKIPPED por falta de chave).
  if (startSuggestion) {
    await startPendingReads(envelopeId, requester);
  }

  return await getInvoiceState(envelopeId, requester);
};

/** Estado atual. Na primeira vez (sem linha), classifica. Envio já enviado de antes da Fase 9: refaz as linhas de arquivo. */
export const getInvoiceState = async (envelopeId: string, requester: InvoiceRequester = {}): Promise<InvoiceState> => {
  const row = await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } });

  if (!row) {
    return await classifyEnvelope(envelopeId, requester);
  }

  if (row.isInvoice === RevalleInvoiceStatus.YES && !(await isEnvelopeDraft(envelopeId))) {
    await ensureLegacyInvoiceFiles(envelopeId);
  }

  return await toInvoiceState(await expireStalePending(row));
};

const requireEditableDraft = async (envelopeId: string) => {
  if (!(await isEnvelopeDraft(envelopeId))) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'O documento já foi enviado.' });
  }

  if (await isDraftLockedForOwner(envelopeId)) {
    throw financeDecidesError();
  }
};

/**
 * O remetente diz se o envio é nota fiscal (`detectedBy = SENDER`, com `flagChangedById`/`flagChangedAt`). "Sim": os
 * arquivos sem texto viram nota (sem eles e sem nenhuma nota, os arquivos "outro"), e começa a leitura de cada nota (o PDF
 * quando o arquivo não tem texto). "Não": as notas e os sem texto viram "outro", e a leitura da IA deles sai (sem custo).
 * Vale até um arquivo mudar.
 */
export const setInvoiceFlag = async ({
  envelopeId,
  isInvoice,
  requester = {},
}: {
  envelopeId: string;
  isInvoice: boolean;
  requester?: InvoiceRequester;
}): Promise<InvoiceState> => {
  await requireEditableDraft(envelopeId);

  // Garante as linhas e o hash atual dos arquivos.
  await classifyEnvelope(envelopeId, requester);

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await lockInvoiceEnvelope(tx, envelopeId);

    const files = await loadInvoiceFiles(envelopeId, tx);
    const ofKind = (kind: RevalleInvoiceFileKind) => files.filter((file) => file.kind === kind);
    const unknown = ofKind(RevalleInvoiceFileKind.UNKNOWN);
    const targets = isInvoice
      ? unknown.length > 0 || ofKind(RevalleInvoiceFileKind.NF).length > 0
        ? unknown
        : ofKind(RevalleInvoiceFileKind.OTHER)
      : [...ofKind(RevalleInvoiceFileKind.NF), ...unknown];
    const changed = {
      detectedBy: RevalleInvoiceDetectedBy.SENDER,
      kindChangedById: requester.userId ?? null,
      kindChangedAt: now,
    };

    if (targets.length > 0) {
      await tx.revalleInvoiceFile.updateMany({
        where: { id: { in: targets.map((file) => file.id) } },
        data: isInvoice
          ? { ...changed, kind: RevalleInvoiceFileKind.NF }
          : { ...changed, kind: RevalleInvoiceFileKind.OTHER, ...CLEARED_FILE_READ },
      });
    }

    const targetIds = new Set(targets.map((file) => file.id));
    const kinds = files.map((file) =>
      targetIds.has(file.id) ? (isInvoice ? RevalleInvoiceFileKind.NF : RevalleInvoiceFileKind.OTHER) : file.kind,
    );

    // A troca fica registrada: quem e quando (spec §3).
    await tx.revalleInvoiceClassification.update({
      where: { envelopeId },
      data: {
        detectedBy: RevalleInvoiceDetectedBy.SENDER,
        flagChangedById: requester.userId ?? null,
        flagChangedAt: now,
        // Envio sem arquivo nenhum: vale a resposta, como antes.
        isInvoice:
          files.length === 0
            ? isInvoice
              ? RevalleInvoiceStatus.YES
              : RevalleInvoiceStatus.NO
            : aggregateIsInvoice(kinds),
      },
    });

    await syncInvoiceEnvelopeMirror(tx, envelopeId);
  });

  if (isInvoice) {
    await startPendingReads(envelopeId, requester);
  }

  return await getInvoiceState(envelopeId, requester);
};

/**
 * Fase 9: o remetente diz o tipo de UM arquivo do rascunho (nota, boleto ou outro), com quem e quando (no arquivo e no
 * envio). "Outro"/"Boleto" apaga a leitura da IA e a escolha daquele arquivo; "Nota" começa a leitura dele. Só rascunho que
 * não esteja travado para o dono (nova versão do Financeiro).
 */
export const setInvoiceFileKind = async ({
  envelopeId,
  envelopeItemId,
  kind,
  requester = {},
}: {
  envelopeId: string;
  envelopeItemId: string;
  kind: 'NF' | 'BOLETO' | 'OTHER';
  requester?: InvoiceRequester;
}): Promise<InvoiceState> => {
  await requireEditableDraft(envelopeId);

  await classifyEnvelope(envelopeId, requester, { startSuggestion: false });

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await lockInvoiceEnvelope(tx, envelopeId);

    const files = await loadInvoiceFiles(envelopeId, tx);
    const file = files.find((candidate) => candidate.envelopeItemId === envelopeItemId);

    if (!file) {
      throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Arquivo não encontrado neste envio.' });
    }

    const changed = {
      detectedBy: RevalleInvoiceDetectedBy.SENDER,
      kindChangedById: requester.userId ?? null,
      kindChangedAt: now,
    };

    await tx.revalleInvoiceFile.update({
      where: { id: file.id },
      data:
        file.kind === kind
          ? changed
          : {
              ...changed,
              kind,
              ...CLEARED_FILE_READ,
              boletoData: Prisma.DbNull,
              ...(kind === RevalleInvoiceFileKind.NF ? {} : CLEARED_FILE_CHOICE),
            },
    });

    await tx.revalleInvoiceClassification.update({
      where: { envelopeId },
      data: {
        detectedBy: RevalleInvoiceDetectedBy.SENDER,
        flagChangedById: requester.userId ?? null,
        flagChangedAt: now,
        isInvoice: aggregateIsInvoice(files.map((candidate) => (candidate.id === file.id ? kind : candidate.kind))),
      },
    });

    await syncInvoiceEnvelopeMirror(tx, envelopeId);
  });

  if (kind === RevalleInvoiceFileKind.NF) {
    await startPendingReads(envelopeId, requester);
  }

  return await getInvoiceState(envelopeId, requester);
};
