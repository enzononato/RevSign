import { prisma } from '@documenso/prisma';
import type { RevalleFinanceStatus, RevalleInvoiceClassification, RevalleInvoiceFile } from '@prisma/client';
import {
  DocumentStatus,
  Prisma,
  RevalleInvoiceFileKind,
  RevalleInvoiceStatus,
  RevalleSuggestionStatus,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { isNewVersionDraftRow, NEW_VERSION_DRAFT_STATUSES } from '../../../revalle/finance/finance-status';
import { extractAccessKeys } from '../../../revalle/invoice/detect-invoice';
import { invoiceMirrorColumns, pickLegacyInvoiceFile } from '../../../revalle/invoice/invoice-files';
import { logger } from '../../../utils/logger';
import { loadEnvelopeFiles, readFilesContent } from './envelope-files';

/**
 * Fase 9: as linhas por arquivo do envio (`RevalleInvoiceFile`), a trava do envio e o espelho na linha do envio.
 *
 * Toda gravação "da nota" segue a mesma ordem: numa transação, `lockInvoiceEnvelope` primeiro (a mesma linha que a
 * selagem trava), confere o que foi lido, grava a linha do arquivo condicionada aos valores lidos e termina com
 * `syncInvoiceEnvelopeMirror`.
 */

export type LoadedInvoiceFile = RevalleInvoiceFile & { order: number; title: string };

/** As linhas de arquivo do envio, na ordem dos arquivos (desempate pelo id), com a ordem e o título do arquivo. */
export const loadInvoiceFiles = async (
  envelopeId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<LoadedInvoiceFile[]> => {
  const rows = await db.revalleInvoiceFile.findMany({
    where: { envelopeId },
    include: { envelopeItem: { select: { order: true, title: true } } },
    orderBy: [{ envelopeItem: { order: 'asc' } }, { id: 'asc' }],
  });

  return rows.map(({ envelopeItem, ...row }) => ({ ...row, order: envelopeItem.order, title: envelopeItem.title }));
};

/**
 * Trava a linha do envio (`SELECT … FOR UPDATE`) e devolve o que as gravações por arquivo conferem: a chave do conjunto
 * de arquivos e a situação no Financeiro. Nulo = o envio não tem classificação.
 */
export const lockInvoiceEnvelope = async (
  tx: Prisma.TransactionClient,
  envelopeId: string,
): Promise<{ fileSha256: string | null; financeStatus: RevalleFinanceStatus | null } | null> => {
  const rows = await tx.$queryRaw<Array<{ fileSha256: string | null; financeStatus: string | null }>>`
    SELECT "fileSha256", "financeStatus"::text AS "financeStatus"
    FROM "RevalleInvoiceClassification"
    WHERE "envelopeId" = ${envelopeId}
    FOR UPDATE`;

  const row = rows[0];

  if (!row) {
    return null;
  }

  return { fileSha256: row.fileSha256, financeStatus: row.financeStatus as RevalleFinanceStatus | null };
};

/**
 * Regrava o espelho da linha do envio a partir das NFs (`invoiceMirrorColumns`). Não toca em `isInvoice`, `fileSha256`,
 * `financeStatus` nem nas colunas de versão. Envio sem linha de arquivo nenhuma (de antes da Fase 9, ainda não refeito):
 * não mexe, para não apagar o que a linha do envio tem.
 */
export const syncInvoiceEnvelopeMirror = async (tx: Prisma.TransactionClient, envelopeId: string): Promise<void> => {
  const files = await loadInvoiceFiles(envelopeId, tx);

  if (files.length === 0) {
    return;
  }

  const mirror = invoiceMirrorColumns(files.filter((file) => file.kind === RevalleInvoiceFileKind.NF));

  await tx.revalleInvoiceClassification.updateMany({
    where: { envelopeId },
    data: {
      ...mirror,
      suggestion: mirror.suggestion === null ? Prisma.DbNull : (mirror.suggestion as Prisma.InputJsonValue),
    },
  });
};

export const INVOICE_FILE_REQUIRED_CODE = 'INVOICE_FILE_REQUIRED';

const INVOICE_FILE_REQUIRED_MESSAGE =
  'Este envio tem mais de uma nota fiscal: diga de qual arquivo é (envelopeItemId).';

/**
 * A NF do envio em que a gravação vale. Sem NF nenhuma: a recusa de hoje. Sem `envelopeItemId`: a NF única (com 2+,
 * `INVOICE_FILE_REQUIRED`, 400). Com ele: tem de ser uma NF deste envio (senão 404).
 */
export const resolveInvoiceFile = async ({
  envelopeId,
  envelopeItemId,
  db = prisma,
}: {
  envelopeId: string;
  envelopeItemId?: string;
  db?: Prisma.TransactionClient;
}): Promise<LoadedInvoiceFile> => {
  const nfs = (await loadInvoiceFiles(envelopeId, db)).filter((file) => file.kind === RevalleInvoiceFileKind.NF);

  if (nfs.length === 0) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'O documento não está marcado como nota fiscal.' });
  }

  if (envelopeItemId === undefined) {
    if (nfs.length > 1) {
      throw new AppError(INVOICE_FILE_REQUIRED_CODE, {
        message: INVOICE_FILE_REQUIRED_MESSAGE,
        userMessage: INVOICE_FILE_REQUIRED_MESSAGE,
        statusCode: 400,
      });
    }

    return nfs[0];
  }

  const file = nfs.find((nf) => nf.envelopeItemId === envelopeItemId);

  if (!file) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Nota fiscal não encontrada neste envio.' });
  }

  return file;
};

/**
 * Grava colunas de linhas de arquivo do envio na ordem de sempre: trava o envio, `updateMany` condicionado (`where`, sempre
 * dentro do envio) e, se gravou, o espelho. Devolve quantas linhas mudaram (0 = a condição não valia mais).
 */
export const updateInvoiceFiles = async ({
  envelopeId,
  where,
  data,
}: {
  envelopeId: string;
  where: Prisma.RevalleInvoiceFileWhereInput;
  data: Prisma.RevalleInvoiceFileUpdateManyMutationInput;
}): Promise<number> =>
  await prisma.$transaction(async (tx) => {
    await lockInvoiceEnvelope(tx, envelopeId);

    const { count } = await tx.revalleInvoiceFile.updateMany({ where: { ...where, envelopeId }, data });

    if (count > 0) {
      await syncInvoiceEnvelopeMirror(tx, envelopeId);
    }

    return count;
  });

const jsonOrDbNull = (value: unknown) => (value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue));

/** As colunas "da nota" da linha do envio, copiadas para a linha NF refeita de um envio de antes da Fase 9. */
const legacyNfColumns = (row: RevalleInvoiceClassification) => ({
  detectedBy: row.detectedBy,
  kindChangedById: row.flagChangedById,
  kindChangedAt: row.flagChangedAt,
  signals: row.signals,
  suggestionStatus: row.suggestionStatus,
  suggestion: jsonOrDbNull(row.suggestion),
  suggestionAttempts: row.suggestionAttempts,
  supplierName: row.supplierName,
  invoiceNumber: row.invoiceNumber,
  totalAmountCents: row.totalAmountCents,
  accessKeys: row.accessKeys,
  choiceCode: row.choiceCode,
  choiceById: row.choiceById,
  choiceAt: row.choiceAt,
  acceptedSuggestion: row.acceptedSuggestion,
  costCenterCode: row.costCenterCode,
  costCenterById: row.costCenterById,
  costCenterAt: row.costCenterAt,
  costCenterValidatedAt: row.costCenterValidatedAt,
  costCenterValidatedById: row.costCenterValidatedById,
  costCenterValidatedByName: row.costCenterValidatedByName,
  approvedById: row.approvedById,
  approvedAt: row.approvedAt,
  approvedAccountName: row.approvedAccountName,
  approvedByName: row.approvedByName,
});

type LegacyRowsOf = (current: RevalleInvoiceClassification) => Prisma.RevalleInvoiceFileCreateManyInput[];

/** As linhas refeitas pelo texto de cada arquivo. Nulo sem arquivo. */
const legacyRowsFromContent = async (envelopeId: string): Promise<LegacyRowsOf | null> => {
  const contents = await readFilesContent(await loadEnvelopeFiles(envelopeId));
  const picked = pickLegacyInvoiceFile(contents);

  if (!picked) {
    return null;
  }

  return (current) =>
    contents.map((content) => {
      if (content !== picked.invoice) {
        return {
          envelopeId,
          envelopeItemId: content.file.envelopeItemId,
          kind: content.isSparse ? RevalleInvoiceFileKind.UNKNOWN : RevalleInvoiceFileKind.OTHER,
          fileSha256: content.file.sha256,
          // Sem isto, a duplicada não acharia a chave se o remetente marcasse este arquivo como nota depois. Só o texto
          // (sem IA, sem log do documento); como a classificação, sem texto = sem chaves.
          accessKeys: content.isSparse ? [] : extractAccessKeys(content.pages),
        };
      }

      const nf = legacyNfColumns(current);

      // A nota caiu num arquivo com texto que não parece nota (um contrato): a leitura automática nunca o manda para a
      // IA (privacidade). FAILED não volta sozinho para a leitura; o "Sugerir de novo" fica com quem vê o arquivo.
      const isBlocked = !picked.canAutoRead && nf.suggestionStatus === RevalleSuggestionStatus.SKIPPED;

      return {
        envelopeId,
        envelopeItemId: content.file.envelopeItemId,
        kind: RevalleInvoiceFileKind.NF,
        fileSha256: content.file.sha256,
        ...nf,
        ...(isBlocked
          ? { suggestionStatus: RevalleSuggestionStatus.FAILED, suggestion: { failure: 'NO_CONTENT' } }
          : {}),
      };
    });
};

/**
 * Sem os arquivos (não deu para ler): as linhas só pelos itens do envio, sem texto nem SHA-256. A nota no primeiro, os
 * outros "outro". Nulo sem item.
 */
const legacyRowsWithoutText = async (envelopeId: string): Promise<LegacyRowsOf | null> => {
  const items = await prisma.envelopeItem.findMany({
    where: { envelopeId },
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });

  if (items.length === 0) {
    return null;
  }

  return (current) =>
    items.map((item, index) =>
      index === 0
        ? { envelopeId, envelopeItemId: item.id, kind: RevalleInvoiceFileKind.NF, ...legacyNfColumns(current) }
        : { envelopeId, envelopeItemId: item.id, kind: RevalleInvoiceFileKind.OTHER },
    );
};

/**
 * Envio NF (`YES`) sem nenhuma linha de arquivo: de antes da Fase 9 e com mais de um arquivo (a migração só cria a linha
 * dos envios de um arquivo). Refaz as linhas: a NF fica no arquivo de `pickLegacyInvoiceFile`, com tudo que a linha do
 * envio tem; os outros arquivos ficam como "outro" (ou "sem texto"). Uma nota só: o espelho continua igual. Só envio já
 * enviado, salvo `allowDraft` (o rascunho de antes da Fase 9 com os mesmos arquivos, que a classificação refaz sem apagar
 * a escolha). Idempotente e seguro contra pedidos simultâneos (trava o envio). Devolve `true` só se criou as linhas (nada
 * a refazer, ou outro pedido já refez: `false`).
 *
 * `withoutTextOnReadError`: se os arquivos não puderem ser lidos (ex.: um sumiu do armazenamento), refaz mesmo assim, sem
 * texto (`legacyRowsWithoutText`), para a ação do Financeiro ou da Contabilidade não ficar travada para sempre.
 */
export const ensureLegacyInvoiceFiles = async (
  envelopeId: string,
  {
    allowDraft = false,
    withoutTextOnReadError = false,
  }: { allowDraft?: boolean; withoutTextOnReadError?: boolean } = {},
): Promise<boolean> => {
  const row = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: {
      isInvoice: true,
      previousEnvelopeId: true,
      financeStatus: true,
      envelope: { select: { status: true } },
    },
  });

  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    return false;
  }

  // O rascunho de uma nova versão (envio parado) está nas filas do Financeiro e da Contabilidade como um enviado: refaz
  // também. O rascunho comum do dono, só com `allowDraft` (a classificação).
  if (!allowDraft && row.envelope.status === DocumentStatus.DRAFT && !isNewVersionDraftRow(row)) {
    return false;
  }

  if ((await prisma.revalleInvoiceFile.count({ where: { envelopeId } })) > 0) {
    return false;
  }

  const rowsOf = await legacyRowsFromContent(envelopeId).catch(async (error: unknown) => {
    if (!withoutTextOnReadError) {
      throw error;
    }

    logger.warn({
      msg: 'revalle.invoice.legacy-files.without-text',
      envelopeId,
      error: error instanceof Error ? error.name : 'unknown',
    });

    return await legacyRowsWithoutText(envelopeId);
  });

  if (!rowsOf) {
    return false;
  }

  return await prisma.$transaction(async (tx) => {
    await lockInvoiceEnvelope(tx, envelopeId);

    const current = await tx.revalleInvoiceClassification.findUnique({ where: { envelopeId } });

    if (
      !current ||
      current.isInvoice !== RevalleInvoiceStatus.YES ||
      (await tx.revalleInvoiceFile.count({ where: { envelopeId } })) > 0
    ) {
      return false;
    }

    const created = await tx.revalleInvoiceFile.createMany({ data: rowsOf(current), skipDuplicates: true });

    await syncInvoiceEnvelopeMirror(tx, envelopeId);

    return created.count > 0;
  });
};

/**
 * Envio NF que as listas, as filas e os contadores contam (enviado, ou o rascunho de uma nova versão com o envio parado)
 * sem nenhuma linha de arquivo NF.
 */
const listedWithoutNfRows = {
  isInvoice: RevalleInvoiceStatus.YES,
  envelope: { revalleInvoiceFiles: { none: { kind: RevalleInvoiceFileKind.NF } } },
  OR: [
    { envelope: { status: { not: DocumentStatus.DRAFT } } },
    {
      envelope: { status: DocumentStatus.DRAFT },
      previousEnvelopeId: { not: null },
      financeStatus: { in: [...NEW_VERSION_DRAFT_STATUSES] },
    },
  ],
} satisfies Prisma.RevalleInvoiceClassificationWhereInput;

/**
 * Na subida: refaz as linhas de arquivo de todo envio NF já enviado (ou rascunho de nova versão parado) que ainda não tem
 * nenhuma (`ensureLegacyInvoiceFiles`). Devolve quantos foram refeitos. Um envio que falha não para os outros (registra só
 * o tipo do erro; a primeira leitura tenta de novo).
 */
export const backfillLegacyInvoiceFiles = async (): Promise<number> => {
  const rows = await prisma.revalleInvoiceClassification.findMany({
    where: {
      ...listedWithoutNfRows,
      // Sem arquivo nenhum não há o que refazer: não volta a cada subida.
      envelope: { revalleInvoiceFiles: { none: {} }, envelopeItems: { some: {} } },
    },
    select: { envelopeId: true },
  });

  let rebuilt = 0;

  for (const { envelopeId } of rows) {
    try {
      if (await ensureLegacyInvoiceFiles(envelopeId)) {
        rebuilt += 1;
      }
    } catch (error) {
      logger.warn({
        msg: 'revalle.invoice.legacy-files.failed',
        envelopeId,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  return rebuilt;
};

/**
 * Quantos envios NF que as listas contam continuam sem linha de arquivo NF (somem da lista, da planilha, das filas e dos
 * contadores até a primeira leitura refazer). Só a contagem, para o log da subida.
 */
export const countInvoicesWithoutFileRows = async (): Promise<number> =>
  await prisma.revalleInvoiceClassification.count({ where: listedWithoutNfRows });
