import { prisma } from '@documenso/prisma';
import { Prisma, RevalleInvoiceStatus, RevalleSuggestionStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { jobs } from '../../../jobs/client';
import { buildInvoicePrompt } from '../../../revalle/invoice/prompt';
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

// 60 sugestões por usuário por hora (primeira sugestão, "Sim" do remetente e "Sugerir de novo") e 5 "Sugerir de novo"
// por documento. Ajustáveis por NEXT_PRIVATE_REVALLE_RATE_LIMITS (ver rate-limit-overrides.ts).
const userSuggestionRateLimit = createRateLimit({ action: 'revalle.invoice-suggest', max: 60, window: '1h' });
const documentResuggestRateLimit = createRateLimit({ action: 'revalle.invoice-resuggest', max: 5, window: '1d' });

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

/**
 * Começa a sugestão de um documento já marcado como NF (`YES`): cache → DONE na hora; IA desligada → SKIPPED;
 * sem contas → FAILED; acima do limite do usuário → FAILED (RATE_LIMITED); senão PENDING + job.
 * `force` ("Sugerir de novo") ignora o cache. Não lança para a tela: o resultado fica na linha da classificação.
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
  const where = { envelopeId, fileSha256, suggestionStatus: { not: RevalleSuggestionStatus.PENDING } };

  if (!isAiAvailable() || !fileSha256) {
    await prisma.revalleInvoiceClassification.updateMany({
      where,
      data: { suggestionStatus: RevalleSuggestionStatus.SKIPPED, suggestion: Prisma.DbNull },
    });

    return;
  }

  const activeCodes = await activeAccountCodes();

  if (activeCodes.size === 0) {
    await prisma.revalleInvoiceClassification.updateMany({
      where,
      data: { suggestionStatus: RevalleSuggestionStatus.FAILED, suggestion: failure('NO_ACCOUNTS') },
    });

    return;
  }

  const cached = force ? null : await readCachedSuggestion(fileSha256, activeCodes);

  if (cached) {
    await prisma.revalleInvoiceClassification.updateMany({
      where,
      data: { suggestionStatus: RevalleSuggestionStatus.DONE, suggestion: cached },
    });

    return;
  }

  if (requester.userId !== undefined) {
    const limit = await userSuggestionRateLimit.check({
      ip: requester.ipAddress ?? 'unknown',
      identifier: `user:${requester.userId}`,
    });

    if (limit.isLimited) {
      await prisma.revalleInvoiceClassification.updateMany({
        where,
        data: { suggestionStatus: RevalleSuggestionStatus.FAILED, suggestion: failure('RATE_LIMITED') },
      });

      return;
    }
  }

  // Só quem fez a transição para PENDING dispara o job (dois pedidos simultâneos não geram duas chamadas).
  const { count } = await prisma.revalleInvoiceClassification.updateMany({
    where,
    data: {
      suggestionStatus: RevalleSuggestionStatus.PENDING,
      suggestion: Prisma.DbNull,
      suggestionAttempts: { increment: 1 },
    },
  });

  if (count === 0) {
    return;
  }

  try {
    await jobs.triggerJob({
      name: 'internal.revalle-invoice-suggest',
      payload: { envelopeId, fileSha256, force },
    });
  } catch {
    await prisma.revalleInvoiceClassification.updateMany({
      where: { envelopeId, fileSha256, suggestionStatus: RevalleSuggestionStatus.PENDING },
      data: { suggestionStatus: RevalleSuggestionStatus.FAILED, suggestion: failure('PROVIDER_ERROR') },
    });
  }
};

/**
 * "Sugerir de novo": só para documento marcado como NF, com a IA ligada. Limites: 5 por documento e 60 por usuário
 * (429). Enquanto uma sugestão está em andamento, não começa outra.
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

  if (!isAiAvailable()) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'A sugestão automática está desligada.' });
  }

  if (row.suggestionStatus === RevalleSuggestionStatus.PENDING) {
    return;
  }

  const ip = requester.ipAddress ?? 'unknown';

  assertRateLimit(await documentResuggestRateLimit.check({ ip, identifier: `envelope:${envelopeId}` }));
  assertRateLimit(await userSuggestionRateLimit.check({ ip, identifier: `user:${requester.userId}` }));

  // O limite do usuário já foi contado acima.
  await startInvoiceSuggestion({ envelopeId, fileSha256: row.fileSha256, force: true });
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
}: {
  envelopeId: string;
  fileSha256: string;
  force: boolean;
}) => {
  const startedAt = Date.now();
  const pendingWhere = { envelopeId, fileSha256, suggestionStatus: RevalleSuggestionStatus.PENDING };
  let model = getRevalleInvoiceAiConfig().model;
  let usage: { inputTokens?: number; outputTokens?: number } = {};
  let input: 'text' | 'pdf' | 'text+pdf' | 'none' = 'none';

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
    });
  };

  try {
    const row = await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } });

    if (!row || row.suggestionStatus !== RevalleSuggestionStatus.PENDING || row.fileSha256 !== fileSha256) {
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

    const text = contents
      .filter((content) => !content.isSparse)
      .map((content) => content.pages.join('\n'))
      .join('\n\n');

    const pdfs: Uint8Array[] = [];
    let pdfBytes = 0;

    for (const content of contents.filter((item) => item.isSparse)) {
      if (pdfBytes + content.file.bytes.length <= MAX_INLINE_PDF_BYTES) {
        pdfs.push(content.file.bytes);
        pdfBytes += content.file.bytes.length;
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
        text: text || undefined,
        pdf: pdfs.length > 0 ? pdfs : undefined,
        signal,
      });

      model = result.model;
      usage = result.usage;

      await finish(interpretRaw(result.raw, activeCodes));
    } catch {
      // O erro do provedor pode trazer o pedido (com o texto da NF): não é registrado.
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
