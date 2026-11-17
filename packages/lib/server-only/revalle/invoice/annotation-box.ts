import { prisma } from '@documenso/prisma';
import { DocumentStatus, Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { type AnnotationBoxRect, clampAnnotationBox } from '../../../revalle/invoice/annotation-box';
import { getEnvelopeWhereInput } from '../../envelope/get-envelope-by-id';

export type InvoiceAnnotationBox = AnnotationBoxRect & { envelopeItemId: string };

type BoxTarget = { userId: number; teamId: number; envelopeId: string; envelopeItemId: string };

const notFound = () => new AppError(AppErrorCode.NOT_FOUND, { message: 'Documento não encontrado.' });

const notDraft = () =>
  new AppError(AppErrorCode.INVALID_REQUEST, {
    message: 'O bloco de conta e centro só muda enquanto o documento é rascunho.',
  });

const toRect = (row: AnnotationBoxRect): AnnotationBoxRect => ({
  page: row.page,
  positionX: row.positionX,
  positionY: row.positionY,
  width: row.width,
  height: row.height,
});

/**
 * Mesma regra de edição dos campos do editor: o envelope que a pessoa pode abrir (`getEnvelopeWhereInput`, com o time
 * da sessão), o arquivo é dele e ele ainda é rascunho. Sem acesso, ou arquivo de outro envelope: 404. Já enviado: 400.
 * Na transação, trava a linha do envelope (`FOR UPDATE`) e confere o rascunho de novo: um envio ao mesmo tempo espera.
 */
const withEditableDraftItem = async <T>(
  { userId, teamId, envelopeId, envelopeItemId }: BoxTarget,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id: { type: 'envelopeId', id: envelopeId },
    type: null,
    userId,
    teamId,
  }).catch(() => {
    throw notFound();
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    select: { id: true, status: true, envelopeItems: { where: { id: envelopeItemId }, select: { id: true } } },
  });

  if (!envelope || envelope.envelopeItems.length === 0) {
    throw notFound();
  }

  if (envelope.status !== DocumentStatus.DRAFT) {
    throw notDraft();
  }

  return await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status"::text AS "status" FROM "Envelope" WHERE "id" = ${envelopeId} FOR UPDATE`;

    if (locked[0]?.status !== DocumentStatus.DRAFT) {
      throw notDraft();
    }

    return await write(tx);
  });
};

/** Põe (ou move) o bloco do arquivo: um por arquivo, sempre dentro da página e com o tamanho mínimo. */
export const setInvoiceAnnotationBox = async ({
  rect,
  ...target
}: BoxTarget & { rect: AnnotationBoxRect }): Promise<AnnotationBoxRect> => {
  const clamped = clampAnnotationBox(rect);

  return await withEditableDraftItem(target, async (tx) => {
    // O arquivo pode ter sido tirado do envio entre a conferência e a gravação (chave estrangeira): 404, como antes.
    const row = await tx.revalleInvoiceAnnotationBox
      .upsert({
        where: { envelopeItemId: target.envelopeItemId },
        create: { envelopeItemId: target.envelopeItemId, envelopeId: target.envelopeId, ...clamped },
        update: clamped,
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
          throw notFound();
        }

        throw error;
      });

    return toRect(row);
  });
};

/** Tira o bloco do arquivo (sem bloco, nada a fazer). */
export const deleteInvoiceAnnotationBox = async (target: BoxTarget): Promise<void> => {
  await withEditableDraftItem(target, async (tx) => {
    await tx.revalleInvoiceAnnotationBox.deleteMany({ where: { envelopeItemId: target.envelopeItemId } });
  });
};

/** Os blocos do envelope, na ordem dos arquivos. Sem conferir acesso: quem chama confere. */
export const findInvoiceAnnotationBoxes = async (envelopeId: string): Promise<InvoiceAnnotationBox[]> => {
  const rows = await prisma.revalleInvoiceAnnotationBox.findMany({
    where: { envelopeId },
    orderBy: [{ envelopeItem: { order: 'asc' } }, { envelopeItemId: 'asc' }],
  });

  return rows.map((row) => ({ envelopeItemId: row.envelopeItemId, ...toRect(row) }));
};

/**
 * Para a rota `find`: a mesma regra de acesso de leitura do editor (o envelope que a pessoa abre com o time da sessão),
 * em qualquer situação do envelope. Sem acesso: 404.
 */
export const findInvoiceAnnotationBoxesForUser = async ({
  userId,
  teamId,
  envelopeId,
}: {
  userId: number;
  teamId: number;
  envelopeId: string;
}): Promise<InvoiceAnnotationBox[]> => {
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id: { type: 'envelopeId', id: envelopeId },
    type: null,
    userId,
    teamId,
  }).catch(() => {
    throw notFound();
  });

  const envelope = await prisma.envelope.findFirst({ where: envelopeWhereInput, select: { id: true } });

  if (!envelope) {
    throw notFound();
  }

  return await findInvoiceAnnotationBoxes(envelopeId);
};

/** Envio de antes do bloco (ou nova versão dele): o editor esconde o bloco. Sem a linha da nota: falso. */
export const findInvoiceAutoAnnotation = async (envelopeId: string): Promise<boolean> => {
  const row = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { autoAnnotation: true },
  });

  return row?.autoAnnotation ?? false;
};

/**
 * O `duplicateEnvelope` do upstream copia os arquivos: o bloco de cada arquivo vai junto, na mesma página e posição
 * (nova versão, duplicar, salvar como modelo). `itemMap`: arquivo de origem → arquivo copiado.
 */
export const copyInvoiceAnnotationBoxes = async ({
  itemMap,
  envelopeId,
  tx = prisma,
}: {
  itemMap: Record<string, string>;
  envelopeId: string;
  /** A transação que criou os arquivos copiados (documento a partir de modelo). */
  tx?: Prisma.TransactionClient;
}): Promise<void> => {
  const boxes = await tx.revalleInvoiceAnnotationBox.findMany({
    where: { envelopeItemId: { in: Object.keys(itemMap) } },
  });

  const data = boxes.flatMap((box) => {
    const envelopeItemId = itemMap[box.envelopeItemId];

    return envelopeItemId ? [{ envelopeItemId, envelopeId, ...toRect(box) }] : [];
  });

  if (data.length > 0) {
    await tx.revalleInvoiceAnnotationBox.createMany({ data, skipDuplicates: true });
  }
};

const ANNOTATION_BOX_MIGRATION = '20261117100000_revalle_annotation_box';

// Quando a migração do bloco terminou neste banco. Lido uma vez; sem a linha (banco sem o histórico do Prisma), nulo e
// lido de novo na próxima vez.
let annotationBoxMigrationAt: Date | null = null;

const findAnnotationBoxMigrationAt = async (): Promise<Date | null> => {
  if (annotationBoxMigrationAt) {
    return annotationBoxMigrationAt;
  }

  const rows = await prisma.$queryRaw<Array<{ finishedAt: Date | null }>>`
    SELECT "finished_at" AS "finishedAt" FROM "_prisma_migrations"
    WHERE "migration_name" = ${ANNOTATION_BOX_MIGRATION} AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
    ORDER BY "finished_at" ASC LIMIT 1`;

  annotationBoxMigrationAt = rows[0]?.finishedAt ?? null;

  return annotationBoxMigrationAt;
};

/**
 * Envio que já tinha saído antes da migração do bloco e ganha a linha da nota só agora (marcado como NF depois do envio):
 * mantém o texto automático, como a migração faz com as linhas que já existiam. A hora do envio é a do primeiro
 * `DOCUMENT_SENT`; sem ele, a criação do envelope.
 */
export const wasSentBeforeAnnotationBox = async (envelopeId: string): Promise<boolean> => {
  const migratedAt = await findAnnotationBoxMigrationAt();

  if (!migratedAt) {
    return false;
  }

  const [sent, envelope] = await Promise.all([
    prisma.documentAuditLog.findFirst({
      where: { envelopeId, type: 'DOCUMENT_SENT' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.envelope.findUnique({ where: { id: envelopeId }, select: { createdAt: true } }),
  ]);
  const sentAt = sent?.createdAt ?? envelope?.createdAt;

  return sentAt !== undefined && sentAt < migratedAt;
};
