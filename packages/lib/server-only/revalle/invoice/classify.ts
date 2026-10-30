import { prisma } from '@documenso/prisma';
import type { RevalleInvoiceClassification } from '@prisma/client';
import { Prisma, RevalleInvoiceDetectedBy, RevalleInvoiceStatus, RevalleSuggestionStatus } from '@prisma/client';

import { detectInvoice } from '../../../revalle/invoice/detect-invoice';
import { filesKey, loadEnvelopeFiles, readFilesContent } from './envelope-files';
import { getRevalleInvoiceAiConfig } from './settings';
import type { InvoiceFailureReason, InvoiceRequester } from './suggest';
import { INVOICE_SUGGESTION_STALE_MS, startInvoiceSuggestion } from './suggest';

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
  choice: { code: string | 'DEFER'; name?: string } | null;
  aiAvailable: boolean;
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

/** Monta o estado da tela. Nomes das contas vêm da lista (inclusive inativas: documento antigo mostra número e nome). */
export const toInvoiceState = async (row: RevalleInvoiceClassification): Promise<InvoiceState> => {
  const stored = readStored(row.suggestion);
  const hasSuggestion =
    row.suggestionStatus === RevalleSuggestionStatus.DONE &&
    typeof stored.accountCode === 'string' &&
    typeof stored.reason === 'string' &&
    typeof stored.confidence === 'string' &&
    CONFIDENCES.has(stored.confidence);

  const codes = [hasSuggestion ? String(stored.accountCode) : null, row.choiceCode].filter((code): code is string =>
    Boolean(code),
  );

  const accounts = new Map(
    codes.length > 0
      ? (
          await prisma.revalleAccountingAccount.findMany({
            where: { code: { in: codes } },
            select: { code: true, name: true, active: true },
          })
        ).map((account) => [account.code, account])
      : [],
  );

  const suggestedAccount = hasSuggestion ? accounts.get(String(stored.accountCode)) : undefined;

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

  const choice: InvoiceState['choice'] = row.choiceDefer
    ? { code: 'DEFER' }
    : row.choiceCode
      ? { code: row.choiceCode, name: accounts.get(row.choiceCode)?.name }
      : null;

  return {
    isInvoice: row.isInvoice,
    detectedBy: row.detectedBy,
    suggestionStatus: row.suggestionStatus,
    suggestion,
    failureReason:
      row.suggestionStatus === RevalleSuggestionStatus.FAILED && typeof stored.failure === 'string'
        ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          (stored.failure as InvoiceFailureReason)
        : null,
    choice,
    aiAvailable: getRevalleInvoiceAiConfig().status === 'CONFIGURED',
  };
};

/** PENDING esquecido (job perdido) vira FAILED/TIMEOUT, para a tela não ficar presa em "Buscando sugestão…". */
const expireStalePending = async (row: RevalleInvoiceClassification) => {
  if (
    row.suggestionStatus !== RevalleSuggestionStatus.PENDING ||
    Date.now() - row.updatedAt.getTime() < INVOICE_SUGGESTION_STALE_MS
  ) {
    return row;
  }

  await prisma.revalleInvoiceClassification.updateMany({
    where: { envelopeId: row.envelopeId, suggestionStatus: RevalleSuggestionStatus.PENDING, updatedAt: row.updatedAt },
    data: { suggestionStatus: RevalleSuggestionStatus.FAILED, suggestion: { failure: 'TIMEOUT' } },
  });

  return await prisma.revalleInvoiceClassification.findUniqueOrThrow({ where: { envelopeId: row.envelopeId } });
};

/**
 * Classifica o documento (idempotente). Lê os PDFs originais de todos os itens; se o conjunto de SHA-256 não mudou
 * desde a última vez, mantém a classificação (inclusive a decisão do remetente). Se mudou (ou é a primeira vez),
 * detecta pelo texto (até 5 páginas por arquivo; basta um arquivo ser NF) e zera a sugestão. Documento NF com a IA
 * ligada começa a sugestão (cache, ou job em segundo plano).
 */
export const classifyEnvelope = async (envelopeId: string, requester: InvoiceRequester = {}): Promise<InvoiceState> => {
  const files = await loadEnvelopeFiles(envelopeId);
  const key = filesKey(files);
  let row = await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } });

  if (!row || row.fileSha256 !== key) {
    const contents = await readFilesContent(files);
    const invoiceFiles = contents.filter((content) => content.detection.status === 'YES');
    // Basta um arquivo ser NF. Sem nenhum, o conjunto decide entre NO e UNKNOWN (todo escaneado = UNKNOWN).
    const overall = detectInvoice(contents.flatMap((content) => content.pages)).status;
    const isInvoice =
      files.length === 0
        ? RevalleInvoiceStatus.NO
        : invoiceFiles.length > 0
          ? RevalleInvoiceStatus.YES
          : overall === 'UNKNOWN'
            ? RevalleInvoiceStatus.UNKNOWN
            : RevalleInvoiceStatus.NO;

    const data = {
      isInvoice,
      detectedBy: RevalleInvoiceDetectedBy.TEXT,
      signals: [...new Set(invoiceFiles.flatMap((content) => content.detection.signals))],
      fileSha256: key,
      suggestionStatus: RevalleSuggestionStatus.SKIPPED,
      suggestion: Prisma.DbNull,
    };

    // Escrita condicionada ao que foi lido: se outro pedido já reclassificou (ou criou), este não desfaz o trabalho
    // dele (inclusive uma sugestão já em andamento).
    if (row) {
      await prisma.revalleInvoiceClassification.updateMany({
        where: { envelopeId, fileSha256: row.fileSha256 },
        data,
      });
    } else {
      await prisma.revalleInvoiceClassification.createMany({
        data: [{ envelopeId, ...data }],
        skipDuplicates: true,
      });
    }

    row = await prisma.revalleInvoiceClassification.findUniqueOrThrow({ where: { envelopeId } });
  }

  // Também cobre a IA ligada depois da classificação (YES que ficou SKIPPED por falta de chave).
  if (row.isInvoice === RevalleInvoiceStatus.YES && row.suggestionStatus === RevalleSuggestionStatus.SKIPPED) {
    await startInvoiceSuggestion({ envelopeId, fileSha256: row.fileSha256, requester });
  }

  return await getInvoiceState(envelopeId, requester);
};

/** Estado atual. Na primeira vez (sem linha), classifica. */
export const getInvoiceState = async (envelopeId: string, requester: InvoiceRequester = {}): Promise<InvoiceState> => {
  const row = await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } });

  if (!row) {
    return await classifyEnvelope(envelopeId, requester);
  }

  return await toInvoiceState(await expireStalePending(row));
};

/**
 * O remetente diz se é nota fiscal (`detectedBy = SENDER`, com `flagChangedById`/`flagChangedAt`). "Sim" começa a sugestão (com o PDF quando o arquivo não
 * tem texto); "Não" apaga a sugestão (sem custo). Vale até o arquivo mudar.
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
  // Garante a linha e o hash atual dos arquivos.
  await classifyEnvelope(envelopeId, requester);

  // A troca fica registrada: quem e quando (spec §3).
  const changed = {
    detectedBy: RevalleInvoiceDetectedBy.SENDER,
    flagChangedById: requester.userId ?? null,
    flagChangedAt: new Date(),
  };

  const row = await prisma.revalleInvoiceClassification.update({
    where: { envelopeId },
    data: isInvoice
      ? { ...changed, isInvoice: RevalleInvoiceStatus.YES }
      : {
          ...changed,
          isInvoice: RevalleInvoiceStatus.NO,
          suggestionStatus: RevalleSuggestionStatus.SKIPPED,
          suggestion: Prisma.DbNull,
        },
  });

  if (isInvoice && row.suggestionStatus === RevalleSuggestionStatus.SKIPPED) {
    await startInvoiceSuggestion({ envelopeId, fileSha256: row.fileSha256, requester });
  }

  return await getInvoiceState(envelopeId, requester);
};
