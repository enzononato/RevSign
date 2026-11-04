import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';
import { RevalleInvoiceStatus } from '@prisma/client';

import { REVALLE_COST_CENTERS } from '../../../revalle/invoice/cost-centers';
import { logger } from '../../../utils/logger';

export type RevalleInvoiceCostCenter = { code: string; name: string };

export type RevalleSigningInvoice = {
  account: { code: string; name: string } | null;
  costCenter: RevalleInvoiceCostCenter | null;
};

/**
 * A conta contábil e o centro de custo que quem assina vê e que ficam congelados na prova, cada um por si: a escolha atual
 * da NF. A correção do centro faz todos assinarem de novo mesmo numa NF sem conta (marcada depois do envio), então o
 * centro não depende dela. Documento comum e NF sem nenhum dos dois devolvem null.
 */
export const findSigningInvoiceAccount = async (
  envelopeId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<RevalleSigningInvoice | null> => {
  const row = await db.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { isInvoice: true, choiceCode: true, costCenterCode: true },
  });

  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    return null;
  }

  const center = REVALLE_COST_CENTERS.find((item) => item.code === row.costCenterCode);

  if (!row.choiceCode && !center) {
    return null;
  }

  const account = row.choiceCode
    ? await db.revalleAccountingAccount.findUnique({ where: { code: row.choiceCode }, select: { name: true } })
    : null;

  return {
    account: row.choiceCode ? { code: row.choiceCode, name: account?.name ?? '' } : null,
    costCenter: center ? { code: center.code, name: center.name } : null,
  };
};

/**
 * Para a página de assinatura: só depois do portão e só com o documento aberto para quem assina (o loader chama com o
 * payload que ele já montou, e nada da NF sai antes disso). Os códigos mostrados ficam no portão do destinatário: a prova
 * só congela o que a página mostrou (o embed não mostra; o que foi escolhido depois que a página abriu também não). A
 * conta e o centro valem em separado: o que a NF não tem grava nulo, e a prova nunca afirma o que a página não mostrou.
 */
export const showSigningInvoiceAccountForToken = async (token: string): Promise<RevalleSigningInvoice | null> => {
  const recipient = await prisma.recipient.findFirst({ where: { token }, select: { id: true, envelopeId: true } });

  if (!recipient) {
    return null;
  }

  const invoice = await findSigningInvoiceAccount(recipient.envelopeId);

  if (invoice) {
    try {
      await prisma.revalleRecipientGate.updateMany({
        where: { recipientId: recipient.id },
        data: {
          invoiceAccountShownCode: invoice.account?.code ?? null,
          invoiceCostCenterShownCode: invoice.costCenter?.code ?? null,
        },
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

  return invoice;
};
