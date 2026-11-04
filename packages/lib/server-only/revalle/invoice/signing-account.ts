import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';
import { RevalleInvoiceStatus } from '@prisma/client';

import { REVALLE_COST_CENTERS } from '../../../revalle/invoice/cost-centers';
import { logger } from '../../../utils/logger';

export type RevalleInvoiceCostCenter = { code: string; name: string };

export type RevalleInvoiceAccount = { code: string; name: string; costCenter: RevalleInvoiceCostCenter | null };

/**
 * A conta contábil que quem assina vê e que fica congelada na prova: a escolha atual da NF, quando ela é uma conta, e o
 * centro de custo dela (Fase 7). Documento comum e NF sem conta (de antes da Fase 6) devolvem null; NF sem centro
 * (marcada depois do envio ou de antes da Fase 7) devolve a conta com `costCenter: null`.
 */
export const findSigningInvoiceAccount = async (
  envelopeId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<RevalleInvoiceAccount | null> => {
  const row = await db.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { isInvoice: true, choiceCode: true, costCenterCode: true },
  });

  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES || !row.choiceCode) {
    return null;
  }

  const account = await db.revalleAccountingAccount.findUnique({
    where: { code: row.choiceCode },
    select: { name: true },
  });

  const center = REVALLE_COST_CENTERS.find((item) => item.code === row.costCenterCode);

  return {
    code: row.choiceCode,
    name: account?.name ?? '',
    costCenter: center ? { code: center.code, name: center.name } : null,
  };
};

/**
 * Para a página de assinatura: só depois do portão e só com o documento aberto para quem assina (o loader chama com o
 * payload que ele já montou, e nada da conta sai antes disso). O número mostrado fica no portão do destinatário: a prova
 * só congela a conta que a página mostrou (o embed não mostra; a conta escolhida depois que a página abriu também não).
 * O centro de custo segue a mesma regra, em separado: NF sem centro grava nulo, e a prova nunca afirma um centro que a
 * página não mostrou.
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
        data: { invoiceAccountShownCode: account.code, invoiceCostCenterShownCode: account.costCenter?.code ?? null },
      });
    } catch (error) {
      // Sem o registro, a prova fica sem a linha da conta e do centro (nunca afirma o que não sabe); a página segue.
      logger.warn({
        msg: 'revalle invoice: falha ao registrar a conta e o centro mostrados',
        recipientId: recipient.id,
        error: String(error),
      });
    }
  }

  return account;
};
