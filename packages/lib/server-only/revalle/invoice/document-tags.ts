import { prisma } from '@documenso/prisma';
import { RevalleInvoiceFileKind, RevalleInvoiceStatus } from '@prisma/client';

import { getTeamById } from '../../team/get-team';
import { getRevalleOwnOnlyScope, revalleOwnOnlyPrismaWhere } from '../visibility/own-only';

export type InvoiceDocumentTags = {
  envelopeId: string;
  account: { code: string; name: string | null } | null;
  costCenterCode: string | null;
  /** Fase 9: quantas notas o envio tem. Com 2+, `account` e `costCenterCode` ficam nulos (a tela diz "3 notas fiscais"). */
  invoiceCount: number;
};

/**
 * Conta e centro de custo das notas fiscais que aparecem na lista de Documentos de um time. Só leitura. Quem não é
 * do time recebe erro (getTeamById); envelopes de outro time ou que não são NF simplesmente não voltam. Fase 9: o envio
 * de várias notas volta com a contagem (cada nota tem a sua conta e o seu centro); o de uma nota, como antes.
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

  // v.26: com "ver só o que enviou ou recebeu", só as notas de que é dono ou destinatário.
  const ownOnly = await getRevalleOwnOnlyScope(userId);

  const rows = await prisma.revalleInvoiceClassification.findMany({
    where: {
      envelopeId: { in: envelopeIds },
      isInvoice: RevalleInvoiceStatus.YES,
      envelope: { teamId, ...(ownOnly ? { AND: [revalleOwnOnlyPrismaWhere(ownOnly)] } : {}) },
    },
    select: {
      envelopeId: true,
      choiceCode: true,
      costCenterCode: true,
      approvedAccountName: true,
      envelope: {
        select: { _count: { select: { revalleInvoiceFiles: { where: { kind: RevalleInvoiceFileKind.NF } } } } },
      },
    },
  });

  // Uma nota (ou o envio antigo ainda sem linhas de arquivo): a do espelho, só com conta ou centro, como antes.
  const invoices = rows
    .map(({ envelope, ...row }) => ({ ...row, invoiceCount: Math.max(1, envelope._count.revalleInvoiceFiles) }))
    .filter((row) => row.invoiceCount > 1 || row.choiceCode !== null || row.costCenterCode !== null);

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
    account:
      invoice.invoiceCount === 1 && invoice.choiceCode
        ? { code: invoice.choiceCode, name: invoice.approvedAccountName ?? accounts.get(invoice.choiceCode) ?? null }
        : null,
    costCenterCode: invoice.invoiceCount === 1 ? invoice.costCenterCode : null,
    invoiceCount: invoice.invoiceCount,
  }));
};
