import { prisma } from '@documenso/prisma';
import type { RevalleInvoiceClassification } from '@prisma/client';
import {
  DocumentStatus,
  Prisma,
  RevalleFinanceStatus,
  RevalleInvoiceDetectedBy,
  RevalleInvoiceStatus,
  RevalleSuggestionStatus,
  RevalleSupersedeKind,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { isNewVersionDraftRow } from '../../../revalle/finance/finance-status';
import { REVALLE_COST_CENTERS } from '../../../revalle/invoice/cost-centers';
import {
  type InvoiceDataSummary,
  NO_INVOICE_DATA_COLUMNS,
  toInvoiceDataSummary,
} from '../../../revalle/invoice/invoice-data';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { findNewVersionKind, findVisibleSuccessor } from '../finance/successor';
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
  /**
   * Fase 8: fornecedor, número e valor que a IA leu da NF com a sugestão. Podem estar errados (a tela diz que vieram da
   * IA) e não entram na assinatura. Nulo quando os três estão vazios.
   */
  invoiceData: InvoiceDataSummary | null;
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

  const choice: InvoiceState['choice'] = row.choiceCode
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
    invoiceData: toInvoiceDataSummary(row),
    choice,
    costCenter: row.costCenterCode
      ? {
          code: row.costCenterCode,
          name: REVALLE_COST_CENTERS.find((center) => center.code === row.costCenterCode)?.name ?? row.costCenterCode,
        }
      : null,
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
 * Escolha da conta e do centro de custo zerada: ela vale para um conjunto de arquivos (trocou o arquivo, escolhe de
 * novo). A nova versão em rascunho cujo arquivo muda volta a ser um rascunho comum do remetente: a aprovação e a validação
 * eram para outro arquivo. Sem a aprovação na linha, ela também não volta numa retomada (`nextClassification`).
 */
const CLEARED_CHOICE = {
  // Fase 8: os dados lidos pela IA eram do arquivo anterior.
  ...NO_INVOICE_DATA_COLUMNS,
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
  financeStatus: null,
  approvedById: null,
  approvedAt: null,
  approvedAccountName: null,
  approvedByName: null,
};

/** Documento já enviado que nunca foi classificado (ex.: enviado antes desta versão): não é tratado como NF. */
const unclassifiedState = (): InvoiceState => ({
  isInvoice: 'NO',
  detectedBy: 'TEXT',
  suggestionStatus: 'SKIPPED',
  suggestion: null,
  failureReason: null,
  invoiceData: null,
  choice: null,
  costCenter: null,
  financeStatus: null,
  isFinanceSendReleased: false,
  supersededByEnvelopeId: null,
  supersedeKind: null,
  aiAvailable: getRevalleInvoiceAiConfig().status === 'CONFIGURED',
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

/**
 * Classifica o documento (idempotente). Lê os PDFs originais de todos os itens; se o conjunto de SHA-256 não mudou
 * desde a última vez, mantém a classificação (inclusive a decisão e a escolha do remetente). Se mudou (ou é a
 * primeira vez), detecta pelo texto (até 5 páginas por arquivo), zera a sugestão e a escolha da conta. É NF se um
 * arquivo for NF; senão, `UNKNOWN` se algum arquivo não tiver texto (escaneado: o remetente decide); senão, `NO`.
 * Documento NF com a IA ligada começa a sugestão (cache, ou job em segundo plano), salvo `startSuggestion: false`.
 *
 * Só rascunho é (re)classificado: depois do envio a classificação fica congelada. O envio pode trocar o PDF
 * (`formValues` gera outro arquivo) e isso não pode apagar a conta escolhida.
 */
export const classifyEnvelope = async (
  envelopeId: string,
  requester: InvoiceRequester = {},
  { startSuggestion = true }: { startSuggestion?: boolean } = {},
): Promise<InvoiceState> => {
  let row = await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } });

  if (!(await isEnvelopeDraft(envelopeId))) {
    return row ? await toInvoiceState(await expireStalePending(row)) : unclassifiedState();
  }

  const files = await loadEnvelopeFiles(envelopeId);
  const key = filesKey(files);

  if (!row || row.fileSha256 !== key) {
    const contents = await readFilesContent(files);
    const invoiceFiles = contents.filter((content) => content.detection.status === 'YES');
    // Um arquivo escaneado ao lado de outro com texto (ex.: NF digitalizada + folha de rosto) pode ser a NF.
    const hasScannedFile = contents.some((content) => content.detection.status === 'UNKNOWN');
    const isInvoice =
      invoiceFiles.length > 0
        ? RevalleInvoiceStatus.YES
        : hasScannedFile
          ? RevalleInvoiceStatus.UNKNOWN
          : RevalleInvoiceStatus.NO;

    const data = {
      isInvoice,
      detectedBy: RevalleInvoiceDetectedBy.TEXT,
      signals: [...new Set(invoiceFiles.flatMap((content) => content.detection.signals))],
      fileSha256: key,
      suggestionStatus: RevalleSuggestionStatus.SKIPPED,
      suggestion: Prisma.DbNull,
      ...CLEARED_CHOICE,
    };

    // Escrita condicionada ao que foi lido: se outro pedido já reclassificou (ou criou), este não desfaz o trabalho
    // dele (inclusive uma sugestão já em andamento).
    if (row) {
      const previous = row;
      const hadChoice = previous.choiceCode !== null;
      const user =
        hadChoice && requester.userId !== undefined
          ? await prisma.user.findUnique({
              where: { id: requester.userId },
              select: { id: true, name: true, email: true },
            })
          : null;

      await prisma.$transaction(async (tx) => {
        const { count } = await tx.revalleInvoiceClassification.updateMany({
          where: { envelopeId, fileSha256: previous.fileSha256 },
          data,
        });

        // A escolha apagada pela troca de arquivo também vai para o histórico (sem usuário = o próprio sistema).
        if (count > 0 && hadChoice) {
          await tx.documentAuditLog.create({
            data: createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_INVOICE_ACCOUNT_SET,
              envelopeId,
              data: {
                fromCode: previous.choiceCode,
                toCode: null,
                reason: 'FILES_CHANGED',
              },
              user,
              requestMetadata: requester.ipAddress ? { ipAddress: requester.ipAddress } : undefined,
            }),
          });
        }
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
  if (
    startSuggestion &&
    row.isInvoice === RevalleInvoiceStatus.YES &&
    row.suggestionStatus === RevalleSuggestionStatus.SKIPPED
  ) {
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
  if (!(await isEnvelopeDraft(envelopeId))) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'O documento já foi enviado.' });
  }

  if (await isDraftLockedForOwner(envelopeId)) {
    throw financeDecidesError();
  }

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
          ...NO_INVOICE_DATA_COLUMNS,
        },
  });

  if (isInvoice && row.suggestionStatus === RevalleSuggestionStatus.SKIPPED) {
    await startInvoiceSuggestion({ envelopeId, fileSha256: row.fileSha256, requester });
  }

  return await getInvoiceState(envelopeId, requester);
};
