import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';

import { sha256Hex } from '../../revalle/sha256';
import { getFileServerSide } from '../../universal/upload/get-file.server';

type Db = Prisma.TransactionClient;

export type OriginalHash = { envelopeItemId: string; originalSha256: string };

/**
 * Lê (fora de transação) os bytes que o signatário verá e calcula o SHA-256 de cada item.
 * Deve rodar depois da injeção de formValues: busca o documentData de novo.
 */
export const computeOriginalHashes = async (envelopeId: string): Promise<OriginalHash[]> => {
  const items = await prisma.envelopeItem.findMany({
    where: { envelopeId },
    include: { documentData: true },
  });

  return await Promise.all(
    items.map(async (item) => ({
      envelopeItemId: item.id,
      originalSha256: sha256Hex(await getFileServerSide(item.documentData)),
    })),
  );
};

/** Grava os hashes originais sem sobrescrever os já existentes (reenvio não altera). */
export const saveOriginalHashes = async (hashes: OriginalHash[], tx: Db = prisma) => {
  if (hashes.length === 0) {
    return;
  }

  await tx.revalleDocumentHash.createMany({ data: hashes, skipDuplicates: true });
};

export const recordOriginalHashes = async (envelopeId: string, tx: Db = prisma) => {
  await saveOriginalHashes(await computeOriginalHashes(envelopeId), tx);
};

/**
 * Grava o hash do PDF selado. Se o envelope foi enviado antes desta versão e não há linha,
 * cria com o original calculado a partir do initialData. No reseal atualiza hash e data.
 */
export const recordFinalHash = async (envelopeItemId: string, finalSha256: string, tx: Db = prisma) => {
  const sealedAt = new Date();
  const existing = await tx.revalleDocumentHash.findUnique({ where: { envelopeItemId } });

  if (existing) {
    await tx.revalleDocumentHash.update({ where: { envelopeItemId }, data: { finalSha256, sealedAt } });

    return;
  }

  const item = await tx.envelopeItem.findUniqueOrThrow({
    where: { id: envelopeItemId },
    include: { documentData: true },
  });
  const original = await getFileServerSide({ type: item.documentData.type, data: item.documentData.initialData });

  await tx.revalleDocumentHash.create({
    data: { envelopeItemId, originalSha256: sha256Hex(original), finalSha256, sealedAt },
  });
};
