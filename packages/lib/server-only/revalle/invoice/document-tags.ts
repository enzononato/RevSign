import { prisma } from '@documenso/prisma';
import { RevalleInvoiceStatus } from '@prisma/client';

import { getTeamById } from '../../team/get-team';

export type InvoiceDocumentTags = {
  envelopeId: string;
  account: { code: string; name: string | null } | null;
  costCenterCode: string | null;
};

/**
 * Conta e centro de custo das notas fiscais que aparecem na lista de Documentos de um time. Só leitura. Quem não é
 * do time recebe erro (getTeamById); envelopes de outro time ou que não são NF simplesmente não voltam.
 */
export const findInvoiceDocumentTags = async ({
  userId,
  teamId,
  envelopeIds,
}: {
  userId: number;
  teamId: number;
  envelopeIds: string[];
}): Promise<InvoiceDocumentTags[]> => {
  if (envelopeIds.length === 0) {
    return [];
  }

  await getTeamById({ userId, teamId });

  const invoices = await prisma.revalleInvoiceClassification.findMany({
    where: {
      envelopeId: { in: envelopeIds },
      isInvoice: RevalleInvoiceStatus.YES,
      envelope: { teamId },
      OR: [{ choiceCode: { not: null } }, { costCenterCode: { not: null } }],
    },
    select: { envelopeId: true, choiceCode: true, costCenterCode: true, approvedAccountName: true },
  });

  const codes = [...new Set(invoices.flatMap((invoice) => (invoice.choiceCode ? [invoice.choiceCode] : [])))];

  // Inclusive contas inativas: documento antigo continua mostrando número e nome.
  const accounts = new Map(
    codes.length > 0
      ? (
          await prisma.revalleAccountingAccount.findMany({
            where: { code: { in: codes } },
            select: { code: true, name: true },
          })
        ).map((account) => [account.code, account.name])
      : [],
  );

  return invoices.map((invoice) => ({
    envelopeId: invoice.envelopeId,
    account: invoice.choiceCode
      ? { code: invoice.choiceCode, name: invoice.approvedAccountName ?? accounts.get(invoice.choiceCode) ?? null }
      : null,
    costCenterCode: invoice.costCenterCode,
  }));
};
