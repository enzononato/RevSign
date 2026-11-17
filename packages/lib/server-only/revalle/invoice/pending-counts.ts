import { prisma } from '@documenso/prisma';
import { EnvelopeType, RevalleInvoiceStatus } from '@prisma/client';

import { isAccountingMember } from '../accounting/members';
import { isFinanceMember } from '../finance/members';
import { accountingPendingFileWhere, financePendingFileWhere } from './find-invoices';

// A contagem lê os mesmos filtros da fila da página (`financeiro=pendentes` e `contabilidade=pendentes`), para o número do
// menu bater com o que a pessoa vê ao abrir "Notas fiscais". NF excluída pelo remetente não espera ninguém. Fase 9: conta
// NOTAS (linhas de arquivo NF), como a lista: um envio de 3 notas aguardando conta 3.
const invoiceFiles = {
  envelope: { type: EnvelopeType.DOCUMENT, deletedAt: null, revalleInvoice: { isInvoice: RevalleInvoiceStatus.YES } },
};

/** Notas aguardando a aprovação do Financeiro. */
export const countInvoicesPendingFinance = async (): Promise<number> =>
  await prisma.revalleInvoiceFile.count({ where: { AND: [invoiceFiles, financePendingFileWhere] } });

/** Notas aguardando a Contabilidade (centro sem validação). O aviso da tela Admin → Perfis usa o mesmo número. */
export const countInvoicesPendingAccounting = async (): Promise<number> =>
  await prisma.revalleInvoiceFile.count({ where: { AND: [invoiceFiles, accountingPendingFileWhere] } });

/**
 * Pendências de quem está logado, para o contador do menu. `null` = a pessoa não é desse perfil (o menu não mostra nada);
 * zero = é do perfil e não há nada esperando. Os perfis são lidos do banco a cada pedido.
 */
export const getInvoicePendingCounts = async (
  userId: number,
): Promise<{ finance: number | null; accounting: number | null }> => {
  const [isFinance, isAccounting] = await Promise.all([isFinanceMember(userId), isAccountingMember(userId)]);

  const [finance, accounting] = await Promise.all([
    isFinance ? countInvoicesPendingFinance() : null,
    isAccounting ? countInvoicesPendingAccounting() : null,
  ]);

  return { finance, accounting };
};
