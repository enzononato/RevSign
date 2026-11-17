import { prisma } from '@documenso/prisma';
import type { RevalleFinanceStatus, RevalleInvoiceClassification, RevalleInvoiceFile } from '@prisma/client';
import { DocumentStatus, Prisma, RevalleInvoiceFileKind, RevalleInvoiceStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { invoiceMirrorColumns } from '../../../revalle/invoice/invoice-files';
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

/**
 * Envio NF (`YES`) sem nenhuma linha de arquivo: de antes da Fase 9 e com mais de um arquivo (a migração só cria a linha
 * dos envios de um arquivo). Refaz as linhas: a NF fica no primeiro arquivo que o texto reconhece como NF (senão no
 * primeiro), com tudo que a linha do envio tem; os outros arquivos ficam como "outro" (ou "sem texto"). Uma nota só: o
 * espelho continua igual. Só envio já enviado, salvo `allowDraft` (o rascunho de antes da Fase 9 com os mesmos arquivos,
 * que a classificação refaz sem apagar a escolha). Idempotente e seguro contra pedidos simultâneos (trava o envio).
 */
export const ensureLegacyInvoiceFiles = async (
  envelopeId: string,
  { allowDraft = false }: { allowDraft?: boolean } = {},
): Promise<void> => {
  const row = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { isInvoice: true, envelope: { select: { status: true } } },
  });

  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    return;
  }

  if (!allowDraft && row.envelope.status === DocumentStatus.DRAFT) {
    return;
  }

  if ((await prisma.revalleInvoiceFile.count({ where: { envelopeId } })) > 0) {
    return;
  }

  const contents = await readFilesContent(await loadEnvelopeFiles(envelopeId));

  if (contents.length === 0) {
    return;
  }

  const invoice = contents.find((content) => content.detection.status === 'YES') ?? contents[0];

  await prisma.$transaction(async (tx) => {
    await lockInvoiceEnvelope(tx, envelopeId);

    const current = await tx.revalleInvoiceClassification.findUnique({ where: { envelopeId } });

    if (
      !current ||
      current.isInvoice !== RevalleInvoiceStatus.YES ||
      (await tx.revalleInvoiceFile.count({ where: { envelopeId } })) > 0
    ) {
      return;
    }

    await tx.revalleInvoiceFile.createMany({
      data: contents.map((content) =>
        content === invoice
          ? {
              envelopeId,
              envelopeItemId: content.file.envelopeItemId,
              kind: RevalleInvoiceFileKind.NF,
              fileSha256: content.file.sha256,
              ...legacyNfColumns(current),
            }
          : {
              envelopeId,
              envelopeItemId: content.file.envelopeItemId,
              kind: content.isSparse ? RevalleInvoiceFileKind.UNKNOWN : RevalleInvoiceFileKind.OTHER,
              fileSha256: content.file.sha256,
            },
      ),
      skipDuplicates: true,
    });

    await syncInvoiceEnvelopeMirror(tx, envelopeId);
  });
};

/**
 * Na subida: refaz as linhas de arquivo de todo envio NF já enviado que ainda não tem nenhuma (`ensureLegacyInvoiceFiles`).
 * Devolve quantos foram refeitos. Um envio que falha não para os outros (a primeira leitura tenta de novo).
 */
export const backfillLegacyInvoiceFiles = async (): Promise<number> => {
  const rows = await prisma.revalleInvoiceClassification.findMany({
    where: {
      isInvoice: RevalleInvoiceStatus.YES,
      envelope: { status: { not: DocumentStatus.DRAFT }, revalleInvoiceFiles: { none: {} } },
    },
    select: { envelopeId: true },
  });

  let rebuilt = 0;

  for (const { envelopeId } of rows) {
    try {
      await ensureLegacyInvoiceFiles(envelopeId);
      rebuilt += 1;
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
