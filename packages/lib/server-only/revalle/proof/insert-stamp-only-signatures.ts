import { FieldType, type Prisma } from '@prisma/client';

/**
 * Na conclusão, todo campo SIGNATURE do destinatário que ficou sem desenho é inserido com uma Signature vazia:
 * a marca dele no PDF será só o carimbo. Único caminho que cria Signature vazia (as rotas de assinatura do
 * cliente recusam valor vazio). Roda na transação que marca o destinatário como assinado, antes da prova.
 */
export const insertRevalleStampOnlySignatures = async (tx: Prisma.TransactionClient, recipientId: number) => {
  const pending = await tx.field.findMany({
    where: { recipientId, type: FieldType.SIGNATURE, inserted: false },
    select: { id: true },
  });

  for (const { id } of pending) {
    // Condicional: se o próprio signatário inseriu o campo nesse meio-tempo, a assinatura dele vale.
    const { count } = await tx.field.updateMany({
      where: { id, inserted: false },
      data: { inserted: true, customText: '' },
    });

    if (count === 0) {
      continue;
    }

    await tx.signature.upsert({
      where: { fieldId: id },
      create: { fieldId: id, recipientId, signatureImageAsBase64: null, typedSignature: null },
      update: { signatureImageAsBase64: null, typedSignature: null },
    });
  }
};
