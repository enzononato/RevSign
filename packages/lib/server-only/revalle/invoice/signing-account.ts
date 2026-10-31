import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';
import { RevalleInvoiceStatus } from '@prisma/client';

import { logger } from '../../../utils/logger';

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
 * payload que ele já montou, e nada da conta sai antes disso). O número mostrado fica no portão do destinatário: a prova
 * só congela a conta que a página mostrou (o embed não mostra; a conta escolhida depois que a página abriu também não).
 */
export const showSigningInvoiceAccountForToken = async (token: string): Promise<RevalleInvoiceAccount | null> => {
  const recipient = await prisma.recipient.findFirst({ where: { token }, select: { id: true, envelopeId: true } });

  if (!recipient) {
    return null;
  }

  const account = await findSigningInvoiceAccount(recipient.envelopeId);

  if (account) {
    try {
      await prisma.revalleRecipientGate.updateMany({
        where: { recipientId: recipient.id },
        data: { invoiceAccountShownCode: account.code },
      });
    } catch (error) {
      // Sem o registro, a prova fica sem a linha da conta (nunca afirma o que não sabe); a página segue.
      logger.warn({
        msg: 'revalle invoice: falha ao registrar a conta mostrada',
        recipientId: recipient.id,
        error: String(error),
      });
    }
  }

  return account;
};
