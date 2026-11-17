import { prisma } from '@documenso/prisma';
import { Prisma, RevalleInvoiceFileKind, RevalleInvoiceStatus, RevalleSuggestionStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { jobs } from '../../../jobs/client';
import { firstPagesPdf } from '../../../revalle/invoice/first-pages-pdf';
import { NO_INVOICE_DATA_COLUMNS, normalizeInvoiceData } from '../../../revalle/invoice/invoice-data';
import { invoicePositions } from '../../../revalle/invoice/invoice-files';
import { buildInvoicePrompt } from '../../../revalle/invoice/prompt';
import { providerStatusCode } from '../../../revalle/invoice/provider-status';
import type { InvoiceSuggestion } from '../../../revalle/invoice/suggestion';
import { validateSuggestion, ZInvoiceAccountSuggestionSchema } from '../../../revalle/invoice/suggestion';
import { logger } from '../../../utils/logger';
import { createRateLimit } from '../../rate-limit/rate-limit';
import { assertRateLimit } from '../../rate-limit/rate-limit-middleware';
import { loadEnvelopeFile, readFilesContent } from './envelope-files';
import { requestGeminiSuggestion } from './gemini';
import { loadInvoiceFiles, resolveInvoiceFile, updateInvoiceFiles } from './invoice-files';
import { getAccountingSettings, getRevalleInvoiceAiConfig } from './settings';

/** Tempo máximo da chamada ao Gemini (spec §4). */
export const INVOICE_SUGGESTION_TIMEOUT_MS = 20_000;

/** PENDING mais velho que isso é tratado como TIMEOUT (job perdido, ex.: o app reiniciou no meio). */
export const INVOICE_SUGGESTION_STALE_MS = 60_000;

/** Soma dos PDFs enviados inline (o limite do Gemini é 20 MB por pedido, já em base64). */
const MAX_INLINE_PDF_BYTES = 12 * 1024 * 1024;

/**
 * Fase 9: chamadas à IA (sem cache) por ARQUIVO de nota, para sempre: a automática + 5. Conta toda partida que não veio do
 * cache, inclusive depois de "Não"/"Sim" do remetente (`suggestionAttempts` da linha do arquivo).
 */
export const INVOICE_MAX_AI_CALLS_PER_FILE = 6;

/** Fase 9: no máximo 20 notas de um envio são lidas pela IA (pela ordem dos arquivos); as seguintes ficam sem sugestão. */
export const INVOICE_MAX_AI_FILES_PER_ENVELOPE = 20;

/** Motivo curto gravado no FAILED. Nunca o texto da NF nem a mensagem do provedor. */
export type InvoiceFailureReason =
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN_ACCOUNT'
  | 'PROVIDER_ERROR'
  | 'NO_ACCOUNTS'
  | 'RATE_LIMITED'
  | 'NO_CONTENT';

/** Formato de `RevalleInvoiceFile.suggestion` da NF (e do espelho na linha do envio). */
export type StoredInvoiceSuggestion = (InvoiceSuggestion & { model: string }) | { failure: InvoiceFailureReason };

// Fase 9: 120 chamadas à IA por usuário por hora (uma por nota: primeira leitura, "Sim" do remetente e "Sugerir de novo")
// e no máximo 1.440 em 24 h (o mesmo teto diário de antes, 60 × 24). Ajustáveis por NEXT_PRIVATE_REVALLE_RATE_LIMITS (ver
// rate-limit-overrides.ts). O limite por arquivo é o contador da linha do arquivo.
const userSuggestionRateLimit = createRateLimit({ action: 'revalle.invoice-suggest', max: 120, window: '1h' });
const userDailySuggestionRateLimit = createRateLimit({
  action: 'revalle.invoice-suggest-daily',
  max: 1440,
  window: '24h',
});

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
 * Fase 8: as colunas da linha que espelham os dados lidos pela IA, tiradas da sugestão. Todo lugar que grava `DONE`
 * passa por aqui, para a coluna e o JSON da sugestão nunca discordarem. A chave de acesso que a IA leu só entra quando a
 * linha ainda não tem nenhuma (o texto dos arquivos não trouxe chave: a NF escaneada) e passa na conferência do dígito. Com
 * a chave do texto na linha, a que a IA devolve é a de uma nota citada, ou um erro, e acusaria por engano.
 */
export const invoiceDataColumns = (suggestion: InvoiceSuggestion, accessKeys: readonly string[]) => {
  const { supplierName, invoiceNumber, totalAmountCents, accessKey } = normalizeInvoiceData(suggestion);

  return {
    supplierName,
    invoiceNumber,
    totalAmountCents,
    accessKeys: accessKey === null || accessKeys.length > 0 ? [...accessKeys] : [accessKey],
  };
};

/**
 * Sugestão do cache (por SHA-256), só se a conta ainda estiver ativa. Conta desativada = sem cache (nova chamada).
 * Entrada de antes da Fase 8 não tem a chave `supplierName` (a gravada depois tem, mesmo nula): conta como ausente, e a
 * próxima sugestão do arquivo chama a IA uma vez.
 */
const readCachedSuggestion = async (fileSha256: string, activeCodes: Set<string>) => {
  const cached = await prisma.revalleInvoiceSuggestionCache.findUnique({ where: { fileSha256 } });

  if (!cached) {
    return null;
  }

  if (!cached.suggestion || typeof cached.suggestion !== 'object' || !('supplierName' in cached.suggestion)) {
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

/** A posição da NF entre as notas do envio, pela ordem dos arquivos (1 = a primeira). */
const nfIndexOf = async (envelopeId: string, fileId: string) =>
  invoicePositions(await loadInvoiceFiles(envelopeId)).get(fileId)?.index ?? Number.POSITIVE_INFINITY;

/**
 * Fase 9: começa a leitura de UM arquivo NF pela IA (a sugestão de conta e os dados da nota). Automática (`force` falso)
 * só a partir de SKIPPED: um DONE/FAILED nunca volta sozinho para PENDING. "Sugerir de novo" (`force`) parte de qualquer
 * estado que não seja PENDING e ignora o cache.
 *
 * Toda escrita é condicionada ao estado lido da linha do arquivo (id, SHA-256 do arquivo, situação e tentativas), com o
 * envio travado e o espelho em seguida: de vários pedidos simultâneos, só um vence; o número da tentativa vai no job, e um
 * job velho sai sem chamar a IA. Os limites só são consumidos por quem venceu. Cache (pela SHA-256 do arquivo) → DONE na
 * hora; IA desligada → nada; sem contas → FAILED; nota além da 20ª do envio, limite do arquivo ou do usuário → FAILED
 * (RATE_LIMITED), ou 429 no "Sugerir de novo".
 */
export const startInvoiceFileRead = async ({
  fileId,
  fileSha256,
  requester = {},
  force = false,
}: {
  fileId: string;
  fileSha256: string | null;
  requester?: InvoiceRequester;
  force?: boolean;
}) => {
  const file = await prisma.revalleInvoiceFile.findUnique({ where: { id: fileId } });

  if (!file || !fileSha256 || file.fileSha256 !== fileSha256 || file.kind !== RevalleInvoiceFileKind.NF) {
    return;
  }

  const canStart = force
    ? file.suggestionStatus !== RevalleSuggestionStatus.PENDING
    : file.suggestionStatus === RevalleSuggestionStatus.SKIPPED;

  if (!canStart || !isAiAvailable()) {
    return;
  }

  const { envelopeId } = file;
  const guard = {
    id: fileId,
    kind: RevalleInvoiceFileKind.NF,
    fileSha256,
    suggestionStatus: file.suggestionStatus,
    suggestionAttempts: file.suggestionAttempts,
  };
  const write = async (
    where: Prisma.RevalleInvoiceFileWhereInput,
    data: Prisma.RevalleInvoiceFileUpdateManyMutationInput,
  ) => await updateInvoiceFiles({ envelopeId, where, data });

  const activeCodes = await activeAccountCodes();

  if (activeCodes.size === 0) {
    // Sem contas, o "Sugerir de novo" de uma sugestão pronta não deixa os dados da anterior para trás.
    await write(guard, {
      suggestionStatus: RevalleSuggestionStatus.FAILED,
      suggestion: failure('NO_ACCOUNTS'),
      ...NO_INVOICE_DATA_COLUMNS,
    });

    return;
  }

  const cached = force ? null : await readCachedSuggestion(fileSha256, activeCodes);

  if (cached) {
    await write(guard, {
      suggestionStatus: RevalleSuggestionStatus.DONE,
      suggestion: cached,
      ...invoiceDataColumns(cached, file.accessKeys),
    });

    return;
  }

  const overLimit =
    file.suggestionAttempts >= INVOICE_MAX_AI_CALLS_PER_FILE ||
    (await nfIndexOf(envelopeId, fileId)) > INVOICE_MAX_AI_FILES_PER_ENVELOPE;

  if (overLimit) {
    if (force) {
      throw tooManyRequests();
    }

    await write(guard, { suggestionStatus: RevalleSuggestionStatus.FAILED, suggestion: failure('RATE_LIMITED') });

    return;
  }

  const attempt = file.suggestionAttempts + 1;

  // Os dados lidos pela IA acompanham a sugestão: começa outra, saem os da anterior (a falha não deixa dado velho).
  const count = await write(guard, {
    suggestionStatus: RevalleSuggestionStatus.PENDING,
    suggestion: Prisma.DbNull,
    suggestionAttempts: attempt,
    ...NO_INVOICE_DATA_COLUMNS,
  });

  if (count === 0) {
    return;
  }

  const ownPending = { id: fileId, suggestionStatus: RevalleSuggestionStatus.PENDING, suggestionAttempts: attempt };

  if (requester.userId !== undefined) {
    const identity = { ip: requester.ipAddress ?? 'unknown', identifier: `user:${requester.userId}` };
    let limit = await userSuggestionRateLimit.check(identity);

    if (!limit.isLimited) {
      limit = await userDailySuggestionRateLimit.check(identity);
    }

    if (limit.isLimited) {
      // A tentativa não chamou a IA: devolve o contador. No "Sugerir de novo", volta ao estado de antes e responde 429.
      await write(
        ownPending,
        force
          ? {
              suggestionStatus: file.suggestionStatus,
              suggestion: storedJson(file.suggestion),
              suggestionAttempts: file.suggestionAttempts,
              supplierName: file.supplierName,
              invoiceNumber: file.invoiceNumber,
              totalAmountCents: file.totalAmountCents,
            }
          : {
              suggestionStatus: RevalleSuggestionStatus.FAILED,
              suggestion: failure('RATE_LIMITED'),
              suggestionAttempts: file.suggestionAttempts,
            },
      );

      if (force) {
        assertRateLimit(limit);
      }

      return;
    }
  }

  try {
    await jobs.triggerJob({
      name: 'internal.revalle-invoice-suggest',
      payload: { envelopeId, envelopeItemId: file.envelopeItemId, fileSha256, force, attempt },
    });
  } catch {
    await write(ownPending, {
      suggestionStatus: RevalleSuggestionStatus.FAILED,
      suggestion: failure('PROVIDER_ERROR'),
    });
  }
};

/**
 * "Sugerir de novo" de uma nota: só em rascunho marcado como NF, com a IA ligada. Sem `envelopeItemId`, vale a nota única
 * (com 2+ notas, 400 `INVOICE_FILE_REQUIRED`). Limites: 6 chamadas à IA por arquivo (a automática + 5) e 120 por usuário
 * por hora / 1.440 em 24 h (429). Enquanto a leitura dessa nota está em andamento, não começa outra.
 */
export const resuggestInvoice = async ({
  envelopeId,
  envelopeItemId,
  requester,
}: {
  envelopeId: string;
  envelopeItemId?: string;
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

  const file = await resolveInvoiceFile({ envelopeId, envelopeItemId });

  if (file.suggestionStatus === RevalleSuggestionStatus.PENDING) {
    return;
  }

  if (file.suggestionAttempts >= INVOICE_MAX_AI_CALLS_PER_FILE) {
    throw tooManyRequests();
  }

  await startInvoiceFileRead({ fileId: file.id, fileSha256: file.fileSha256, requester, force: true });
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

  // A parte da conta é o que decide: um dado da NF com tipo errado não faz a resposta "inválida".
  return {
    status: 'FAILED',
    reason: ZInvoiceAccountSuggestionSchema.safeParse(candidate).success ? 'UNKNOWN_ACCOUNT' : 'INVALID_RESPONSE',
  };
};

/**
 * Corpo do job: lê o arquivo original da nota, monta o pedido (o texto dele, ou o PDF quando ele não tem texto), chama o
 * Gemini com 20 s de limite e grava DONE (e o cache) ou FAILED com um código curto na linha do arquivo (e o espelho). Nunca
 * lança. Se o arquivo mudou (ou deixou de ser NF) no meio do caminho, o resultado é descartado (a nova classificação cuida).
 * Só o arquivo desta nota vai para a IA: os outros (um contrato com dados pessoais, outra nota) ficam de fora.
 */
export const runInvoiceFileRead = async ({
  fileId,
  fileSha256,
  force,
  attempt,
}: {
  fileId: string;
  fileSha256: string;
  force: boolean;
  /** `suggestionAttempts` gravado na partida: outro valor = este job ficou velho e não chama a IA. */
  attempt: number;
}) => {
  const startedAt = Date.now();
  const pendingWhere = {
    id: fileId,
    fileSha256,
    suggestionStatus: RevalleSuggestionStatus.PENDING,
    suggestionAttempts: attempt,
  };
  let envelopeId = '';
  let envelopeItemId = '';
  let model = getRevalleInvoiceAiConfig().model;
  let usage: { inputTokens?: number; outputTokens?: number } = {};
  let input: 'text' | 'pdf' | 'none' = 'none';
  // Só o código HTTP do provedor (429, 403, 404…), nunca a mensagem nem o corpo do erro.
  let providerStatus: number | undefined;
  // As chaves da linha quando o job começou: a chave lida pela IA soma-se a elas. Só a troca de arquivo as muda, e ela
  // também muda `fileSha256`, que o `pendingWhere` confere.
  let storedAccessKeys: string[] = [];

  const write = async (data: Prisma.RevalleInvoiceFileUpdateManyMutationInput) =>
    await updateInvoiceFiles({ envelopeId, where: pendingWhere, data });

  // Só metadados: nunca o texto da NF, o prompt ou a resposta.
  const logResult = (result: 'DONE' | 'FAILED', reason?: InvoiceFailureReason, discarded = false) => {
    logger.info({
      msg: 'revalle.invoice.suggestion',
      envelopeId,
      envelopeItemId,
      kind: 'NF',
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

  const finish = async (outcome: SuggestionOutcome) => {
    if (outcome.status === 'DONE') {
      const stored = { ...outcome.suggestion, model };

      const count = await write({
        suggestionStatus: RevalleSuggestionStatus.DONE,
        suggestion: stored,
        ...invoiceDataColumns(outcome.suggestion, storedAccessKeys),
      });

      // O resultado vale para o arquivo, mesmo que o envio tenha mudado: guarda no cache.
      await prisma.revalleInvoiceSuggestionCache.upsert({
        where: { fileSha256 },
        create: { fileSha256, suggestion: outcome.suggestion, model },
        update: { suggestion: outcome.suggestion, model, createdAt: new Date() },
      });

      logResult('DONE', undefined, count === 0);

      return;
    }

    const count = await write({
      suggestionStatus: RevalleSuggestionStatus.FAILED,
      suggestion: failure(outcome.reason),
    });

    logResult('FAILED', outcome.reason, count === 0);
  };

  try {
    const file = await prisma.revalleInvoiceFile.findUnique({ where: { id: fileId } });

    if (
      !file ||
      file.suggestionStatus !== RevalleSuggestionStatus.PENDING ||
      file.fileSha256 !== fileSha256 ||
      file.suggestionAttempts !== attempt
    ) {
      return;
    }

    envelopeId = file.envelopeId;
    envelopeItemId = file.envelopeItemId;
    storedAccessKeys = file.accessKeys;

    const current = await loadEnvelopeFile(file.envelopeItemId).catch(() => null);

    if (!current || current.sha256 !== fileSha256 || file.kind !== RevalleInvoiceFileKind.NF) {
      await write({ suggestionStatus: RevalleSuggestionStatus.SKIPPED, suggestion: Prisma.DbNull });

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

    const [settings, accounts, [content]] = await Promise.all([
      getAccountingSettings(),
      prisma.revalleAccountingAccount.findMany({
        where: { active: true },
        orderBy: { code: 'asc' },
        select: { code: true, name: true, description: true, kind: true },
      }),
      readFilesContent([current]),
    ]);

    // Arquivo com texto: vai o texto. Sem texto (escaneado): vai SÓ o PDF dele (as primeiras páginas).
    const text = content.isSparse ? '' : content.pages.join('\n');
    const pdf = content.isSparse ? await firstPagesPdf(content.file.bytes) : null;
    const pdfs = pdf && pdf.length <= MAX_INLINE_PDF_BYTES ? [pdf] : [];

    input = text.trim() ? 'text' : pdfs.length > 0 ? 'pdf' : 'none';

    if (input === 'none') {
      await finish({ status: 'FAILED', reason: 'NO_CONTENT' });

      return;
    }

    const signal = AbortSignal.timeout(INVOICE_SUGGESTION_TIMEOUT_MS);

    try {
      const result = await requestGeminiSuggestion({
        prompt: buildInvoicePrompt({ userPrompt: settings.prompt, accounts }),
        accountCodes: accounts.map((account) => account.code),
        text: input === 'text' ? [text] : undefined,
        pdf: input === 'pdf' ? pdfs : undefined,
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
    if (envelopeId) {
      await write({ suggestionStatus: RevalleSuggestionStatus.FAILED, suggestion: failure('PROVIDER_ERROR') }).catch(
        () => undefined,
      );
    }

    logResult('FAILED', 'PROVIDER_ERROR');
  }
};
