import { prisma } from '@documenso/prisma';
import { Prisma, RevalleInvoiceStatus, RevalleSuggestionStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { jobs } from '../../../jobs/client';
import { firstPagesPdf } from '../../../revalle/invoice/first-pages-pdf';
import { buildInvoicePrompt } from '../../../revalle/invoice/prompt';
import { providerStatusCode } from '../../../revalle/invoice/provider-status';
import type { InvoiceSuggestion } from '../../../revalle/invoice/suggestion';
import { validateSuggestion, ZInvoiceSuggestionSchema } from '../../../revalle/invoice/suggestion';
import { logger } from '../../../utils/logger';
import { createRateLimit } from '../../rate-limit/rate-limit';
import { assertRateLimit } from '../../rate-limit/rate-limit-middleware';
import { filesKey, loadEnvelopeFiles, readFilesContent } from './envelope-files';
import { requestGeminiSuggestion } from './gemini';
import { getAccountingSettings, getRevalleInvoiceAiConfig } from './settings';

/** Tempo máximo da chamada ao Gemini (spec §4). */
export const INVOICE_SUGGESTION_TIMEOUT_MS = 20_000;

/** PENDING mais velho que isso é tratado como TIMEOUT (job perdido, ex.: o app reiniciou no meio). */
export const INVOICE_SUGGESTION_STALE_MS = 60_000;

/** Soma dos PDFs enviados inline (o limite do Gemini é 20 MB por pedido, já em base64). */
const MAX_INLINE_PDF_BYTES = 12 * 1024 * 1024;

/**
 * Chamadas à IA (sem cache) por documento, para sempre: a automática + 5. Conta toda partida que não veio do cache,
 * inclusive depois de "Não"/"Sim" do remetente (`suggestionAttempts`).
 */
export const INVOICE_MAX_AI_CALLS_PER_DOCUMENT = 6;

/** Motivo curto gravado no FAILED. Nunca o texto da NF nem a mensagem do provedor. */
export type InvoiceFailureReason =
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN_ACCOUNT'
  | 'PROVIDER_ERROR'
  | 'NO_ACCOUNTS'
  | 'RATE_LIMITED'
  | 'NO_CONTENT';

/** Formato de `RevalleInvoiceClassification.suggestion`. */
export type StoredInvoiceSuggestion = (InvoiceSuggestion & { model: string }) | { failure: InvoiceFailureReason };

// 60 chamadas à IA por usuário por hora (primeira sugestão, "Sim" do remetente e "Sugerir de novo"). Ajustável por
// NEXT_PRIVATE_REVALLE_RATE_LIMITS (ver rate-limit-overrides.ts). O limite por documento é o contador da linha.
const userSuggestionRateLimit = createRateLimit({ action: 'revalle.invoice-suggest', max: 60, window: '1h' });

export type InvoiceRequester = { userId?: number; ipAddress?: string | null };

const isAiAvailable = () => getRevalleInvoiceAiConfig().status === 'CONFIGURED';

const activeAccountCodes = async () =>
  new Set(
    (await prisma.revalleAccountingAccount.findMany({ where: { active: true }, select: { code: true } })).map(
      (account) => account.code,
    ),
  );

const failure = (reason: InvoiceFailureReason): Prisma.InputJsonValue => ({ failure: reason });

/**
 * Sugestão do cache (por SHA-256), só se a conta ainda estiver ativa. Conta desativada = sem cache (nova chamada).
 */
const readCachedSuggestion = async (fileSha256: string, activeCodes: Set<string>) => {
  const cached = await prisma.revalleInvoiceSuggestionCache.findUnique({ where: { fileSha256 } });

  if (!cached) {
    return null;
  }

  const suggestion = validateSuggestion(cached.suggestion, activeCodes);

  return suggestion ? { ...suggestion, model: cached.model } : null;
};

const tooManyRequests = () =>
  new AppError(AppErrorCode.TOO_MANY_REQUESTS, { message: 'Limite de sugestões deste documento atingido.' });

const storedJson = (value: unknown) =>
  value === null || value === undefined
    ? Prisma.DbNull
    : // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      (value as Prisma.InputJsonValue);

/**
 * Começa a sugestão de um documento marcado como NF (`YES`). Automática (`force` falso) só a partir de SKIPPED: um
 * DONE/FAILED nunca volta sozinho para PENDING. "Sugerir de novo" (`force`) parte de qualquer estado que não seja
 * PENDING e ignora o cache.
 *
 * Toda escrita é condicionada ao estado lido (status + `suggestionAttempts`): de vários pedidos simultâneos, só um
 * vence; o número da tentativa vai no job, e um job velho sai sem chamar a IA. Os limites só são consumidos por quem
 * venceu. Cache → DONE na hora; IA desligada → nada; sem contas → FAILED; limite do documento ou do usuário →
 * FAILED (RATE_LIMITED), ou 429 no "Sugerir de novo".
 */
export const startInvoiceSuggestion = async ({
  envelopeId,
  fileSha256,
  requester = {},
  force = false,
}: {
  envelopeId: string;
  fileSha256: string | null;
  requester?: InvoiceRequester;
  force?: boolean;
}) => {
  const row = await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } });

  if (!row || !fileSha256 || row.fileSha256 !== fileSha256 || row.isInvoice !== RevalleInvoiceStatus.YES) {
    return;
  }

  const canStart = force
    ? row.suggestionStatus !== RevalleSuggestionStatus.PENDING
    : row.suggestionStatus === RevalleSuggestionStatus.SKIPPED;

  if (!canStart || !isAiAvailable()) {
    return;
  }

  const guard = {
    envelopeId,
    fileSha256,
    suggestionStatus: row.suggestionStatus,
    suggestionAttempts: row.suggestionAttempts,
  };

  const activeCodes = await activeAccountCodes();

  if (activeCodes.size === 0) {
    await prisma.revalleInvoiceClassification.updateMany({
      where: guard,
      data: { suggestionStatus: RevalleSuggestionStatus.FAILED, suggestion: failure('NO_ACCOUNTS') },
    });

    return;
  }

  const cached = force ? null : await readCachedSuggestion(fileSha256, activeCodes);

  if (cached) {
    await prisma.revalleInvoiceClassification.updateMany({
      where: guard,
      data: { suggestionStatus: RevalleSuggestionStatus.DONE, suggestion: cached },
    });

    return;
  }

  if (row.suggestionAttempts >= INVOICE_MAX_AI_CALLS_PER_DOCUMENT) {
    if (force) {
      throw tooManyRequests();
    }

    await prisma.revalleInvoiceClassification.updateMany({
      where: guard,
      data: { suggestionStatus: RevalleSuggestionStatus.FAILED, suggestion: failure('RATE_LIMITED') },
    });

    return;
  }

  const attempt = row.suggestionAttempts + 1;

  const { count } = await prisma.revalleInvoiceClassification.updateMany({
    where: guard,
    data: { suggestionStatus: RevalleSuggestionStatus.PENDING, suggestion: Prisma.DbNull, suggestionAttempts: attempt },
  });

  if (count === 0) {
    return;
  }

  const ownPending = { envelopeId, suggestionStatus: RevalleSuggestionStatus.PENDING, suggestionAttempts: attempt };

  if (requester.userId !== undefined) {
    const limit = await userSuggestionRateLimit.check({
      ip: requester.ipAddress ?? 'unknown',
      identifier: `user:${requester.userId}`,
    });

    if (limit.isLimited) {
      // A tentativa não chamou a IA: devolve o contador. No "Sugerir de novo", volta ao estado de antes e responde 429.
      await prisma.revalleInvoiceClassification.updateMany({
        where: ownPending,
        data: force
          ? {
              suggestionStatus: row.suggestionStatus,
              suggestion: storedJson(row.suggestion),
              suggestionAttempts: row.suggestionAttempts,
            }
          : {
              suggestionStatus: RevalleSuggestionStatus.FAILED,
              suggestion: failure('RATE_LIMITED'),
              suggestionAttempts: row.suggestionAttempts,
            },
      });

      if (force) {
        assertRateLimit(limit);
      }

      return;
    }
  }

  try {
    await jobs.triggerJob({
      name: 'internal.revalle-invoice-suggest',
      payload: { envelopeId, fileSha256, force, attempt },
    });
  } catch {
    await prisma.revalleInvoiceClassification.updateMany({
      where: ownPending,
      data: { suggestionStatus: RevalleSuggestionStatus.FAILED, suggestion: failure('PROVIDER_ERROR') },
    });
  }
};

/**
 * "Sugerir de novo": só para documento marcado como NF, com a IA ligada. Limites: 6 chamadas à IA por documento
 * (a automática + 5) e 60 por usuário por hora (429). Enquanto uma sugestão está em andamento, não começa outra.
 */
export const resuggestInvoice = async ({
  envelopeId,
  requester,
}: {
  envelopeId: string;
  requester: InvoiceRequester & { userId: number };
}) => {
  const row = await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } });

  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'O documento não está marcado como nota fiscal.' });
  }

  const envelope = await prisma.envelope.findUnique({ where: { id: envelopeId }, select: { status: true } });

  // Depois do envio a classificação fica congelada: nada de IA (nem marcando como NF depois).
  if (envelope?.status !== 'DRAFT') {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'Depois do envio, a sugestão automática não roda.' });
  }

  if (!isAiAvailable()) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'A sugestão automática está desligada.' });
  }

  if (row.suggestionStatus === RevalleSuggestionStatus.PENDING) {
    return;
  }

  if (row.suggestionAttempts >= INVOICE_MAX_AI_CALLS_PER_DOCUMENT) {
    throw tooManyRequests();
  }

  await startInvoiceSuggestion({ envelopeId, fileSha256: row.fileSha256, requester, force: true });
};

type SuggestionOutcome =
  | { status: 'DONE'; suggestion: InvoiceSuggestion }
  | { status: 'FAILED'; reason: InvoiceFailureReason };

const interpretRaw = (raw: unknown, activeCodes: Set<string>): SuggestionOutcome => {
  const suggestion = validateSuggestion(raw, activeCodes);

  if (suggestion) {
    return { status: 'DONE', suggestion };
  }

  // Distingue "conta que não existe" de "resposta que não é o JSON pedido".
  let candidate = raw;

  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return { status: 'FAILED', reason: 'INVALID_RESPONSE' };
    }
  }

  return {
    status: 'FAILED',
    reason: ZInvoiceSuggestionSchema.safeParse(candidate).success ? 'UNKNOWN_ACCOUNT' : 'INVALID_RESPONSE',
  };
};

/**
 * Corpo do job: lê os arquivos originais, monta o pedido (texto, ou o PDF quando o arquivo não tem texto), chama o
 * Gemini com 20 s de limite e grava DONE (e o cache) ou FAILED com um código curto. Nunca lança. Se os arquivos do
 * documento mudaram no meio do caminho, o resultado é descartado (a nova classificação cuida).
 */
export const runInvoiceSuggestion = async ({
  envelopeId,
  fileSha256,
  force,
  attempt,
}: {
  envelopeId: string;
  fileSha256: string;
  force: boolean;
  /** `suggestionAttempts` gravado na partida: outro valor = este job ficou velho e não chama a IA. */
  attempt: number;
}) => {
  const startedAt = Date.now();
  const pendingWhere = {
    envelopeId,
    fileSha256,
    suggestionStatus: RevalleSuggestionStatus.PENDING,
    suggestionAttempts: attempt,
  };
  let model = getRevalleInvoiceAiConfig().model;
  let usage: { inputTokens?: number; outputTokens?: number } = {};
  let input: 'text' | 'pdf' | 'text+pdf' | 'none' = 'none';
  // Só o código HTTP do provedor (429, 403, 404…), nunca a mensagem nem o corpo do erro.
  let providerStatus: number | undefined;

  const finish = async (outcome: SuggestionOutcome) => {
    if (outcome.status === 'DONE') {
      const stored = { ...outcome.suggestion, model };

      const { count } = await prisma.revalleInvoiceClassification.updateMany({
        where: pendingWhere,
        data: { suggestionStatus: RevalleSuggestionStatus.DONE, suggestion: stored },
      });

      // O resultado vale para o arquivo, mesmo que o documento tenha mudado: guarda no cache.
      await prisma.revalleInvoiceSuggestionCache.upsert({
        where: { fileSha256 },
        create: { fileSha256, suggestion: outcome.suggestion, model },
        update: { suggestion: outcome.suggestion, model, createdAt: new Date() },
      });

      logResult('DONE', undefined, count === 0);

      return;
    }

    const { count } = await prisma.revalleInvoiceClassification.updateMany({
      where: pendingWhere,
      data: { suggestionStatus: RevalleSuggestionStatus.FAILED, suggestion: failure(outcome.reason) },
    });

    logResult('FAILED', outcome.reason, count === 0);
  };

  // Só metadados: nunca o texto da NF, o prompt ou a resposta.
  const logResult = (result: 'DONE' | 'FAILED', reason?: InvoiceFailureReason, discarded = false) => {
    logger.info({
      msg: 'revalle.invoice.suggestion',
      envelopeId,
      result,
      reason,
      discarded,
      force,
      model,
      input,
      durationMs: Date.now() - startedAt,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      providerStatusCode: providerStatus,
    });
  };

  try {
    const row = await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } });

    if (
      !row ||
      row.suggestionStatus !== RevalleSuggestionStatus.PENDING ||
      row.fileSha256 !== fileSha256 ||
      row.suggestionAttempts !== attempt
    ) {
      return;
    }

    const files = await loadEnvelopeFiles(envelopeId);

    if (filesKey(files) !== fileSha256 || row.isInvoice !== RevalleInvoiceStatus.YES) {
      await prisma.revalleInvoiceClassification.updateMany({
        where: pendingWhere,
        data: { suggestionStatus: RevalleSuggestionStatus.SKIPPED, suggestion: Prisma.DbNull },
      });

      return;
    }

    const activeCodes = await activeAccountCodes();

    if (activeCodes.size === 0) {
      await finish({ status: 'FAILED', reason: 'NO_ACCOUNTS' });

      return;
    }

    if (!force) {
      const cached = await readCachedSuggestion(fileSha256, activeCodes);

      if (cached) {
        model = cached.model;
        await finish({ status: 'DONE', suggestion: cached });

        return;
      }
    }

    const [settings, accounts, contents] = await Promise.all([
      getAccountingSettings(),
      prisma.revalleAccountingAccount.findMany({
        where: { active: true },
        orderBy: { code: 'asc' },
        select: { code: true, name: true, description: true, kind: true },
      }),
      readFilesContent(files),
    ]);

    // Só os arquivos detectados como NF vão para a IA: num documento com contrato + NF, o contrato fica de fora.
    // Sem nenhum arquivo NF (o remetente disse "Sim"): se há escaneados, a NF é um deles e vai SÓ o PDF deles (o
    // texto dos outros, ex. um contrato com dados pessoais, fica de fora); sem escaneados, vai o texto dos arquivos.
    const invoiceFiles = contents.filter((content) => content.detection.status === 'YES');
    const sparseFiles = contents.filter((content) => content.isSparse);
    const textFiles =
      invoiceFiles.length > 0 ? invoiceFiles : sparseFiles.length > 0 ? [] : contents.filter((c) => !c.isSparse);
    const scannedFiles = invoiceFiles.length > 0 ? [] : sparseFiles;

    const texts = textFiles.map((content) => content.pages.join('\n')).filter((text) => text.trim());
    const text = texts.join('\n\n');

    const pdfs: Uint8Array[] = [];
    let pdfBytes = 0;

    for (const content of scannedFiles) {
      const trimmed = await firstPagesPdf(content.file.bytes);

      if (pdfBytes + trimmed.length <= MAX_INLINE_PDF_BYTES) {
        pdfs.push(trimmed);
        pdfBytes += trimmed.length;
      }
    }

    input = text && pdfs.length > 0 ? 'text+pdf' : text ? 'text' : pdfs.length > 0 ? 'pdf' : 'none';

    if (input === 'none') {
      await finish({ status: 'FAILED', reason: 'NO_CONTENT' });

      return;
    }

    const signal = AbortSignal.timeout(INVOICE_SUGGESTION_TIMEOUT_MS);

    try {
      const result = await requestGeminiSuggestion({
        prompt: buildInvoicePrompt({ userPrompt: settings.prompt, accounts }),
        text: texts.length > 0 ? texts : undefined,
        pdf: pdfs.length > 0 ? pdfs : undefined,
        signal,
      });

      model = result.model;
      usage = result.usage;

      await finish(interpretRaw(result.raw, activeCodes));
    } catch (error) {
      // O erro do provedor pode trazer o pedido (com o texto da NF) e o corpo da resposta: só o código HTTP vai
      // para o log (diferencia cota esgotada, chave inválida e modelo retirado).
      providerStatus = providerStatusCode(error);
      await finish({ status: 'FAILED', reason: signal.aborted ? 'TIMEOUT' : 'PROVIDER_ERROR' });
    }
  } catch {
    await prisma.revalleInvoiceClassification
      .updateMany({
        where: pendingWhere,
        data: { suggestionStatus: RevalleSuggestionStatus.FAILED, suggestion: failure('PROVIDER_ERROR') },
      })
      .catch(() => undefined);

    logResult('FAILED', 'PROVIDER_ERROR');
  }
};
