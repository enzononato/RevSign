import { prisma } from '@documenso/prisma';
import type { RevalleFinanceStatus, RevalleInvoiceFile } from '@prisma/client';
import { Prisma, RevalleInvoiceFileKind } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { invoiceMirrorColumns } from '../../../revalle/invoice/invoice-files';

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
