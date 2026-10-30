import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';
import { RevalleInvoiceStatus } from '@prisma/client';

export type RevalleInvoiceAccount = { code: string; name: string };

/**
 * A conta contábil que quem assina vê e que fica congelada na prova: a escolha atual da NF, quando ela é uma conta.
 * "Deixar para o Financeiro" nunca chega a quem assina (o envio fica retido até a conta ser definida); documento comum
 * e NF sem conta (de antes da Fase 6) devolvem null.
 */
export const findSigningInvoiceAccount = async (
  envelopeId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<RevalleInvoiceAccount | null> => {
  const row = await db.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { isInvoice: true, choiceCode: true, choiceDefer: true },
  });

  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES || row.choiceDefer || !row.choiceCode) {
    return null;
  }

  const account = await db.revalleAccountingAccount.findUnique({
    where: { code: row.choiceCode },
    select: { name: true },
  });

  return { code: row.choiceCode, name: account?.name ?? '' };
};

/**
 * Para a página de assinatura: só depois do portão e só com o documento aberto para quem assina (o loader chama com o
 * payload que ele já montou, e nada da conta sai antes disso).
 */
export const findSigningInvoiceAccountForToken = async (token: string): Promise<RevalleInvoiceAccount | null> => {
  const recipient = await prisma.recipient.findFirst({ where: { token }, select: { envelopeId: true } });

  return recipient ? await findSigningInvoiceAccount(recipient.envelopeId) : null;
};
