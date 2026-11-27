import { prisma } from '@documenso/prisma';
import { EnvelopeType, type Prisma, RevalleInvoiceStatus } from '@prisma/client';

import { isAdmin } from '../../../utils/is-admin';
import { isAccountingMember } from '../accounting/members';
import { isFinanceMember } from '../finance/members';
import { accountingPendingFileWhere, financePendingFileWhere } from './find-invoices';
import { invoiceScopeWhere } from './unit-scope';

// A contagem lê os mesmos filtros da fila da página (`financeiro=pendentes` e `contabilidade=pendentes`), para o número do
// menu bater com o que a pessoa vê ao abrir "Notas fiscais". NF excluída pelo remetente não espera ninguém. Fase 9: conta
// NOTAS (linhas de arquivo NF), como a lista: um envio de 3 notas aguardando conta 3.
const invoiceFiles = {
  envelope: { type: EnvelopeType.DOCUMENT, deletedAt: null, revalleInvoice: { isInvoice: RevalleInvoiceStatus.YES } },
};

const scoped = (scopeUserId: number | undefined): Prisma.RevalleInvoiceFileWhereInput =>
  scopeUserId === undefined ? {} : { envelope: invoiceScopeWhere(scopeUserId) };

/**
 * Notas aguardando a aprovação do Financeiro. v.26: com `scopeUserId`, só as das unidades dessa pessoa (o contador do
 * menu); sem ele, todas (o admin).
 */
export const countInvoicesPendingFinance = async (scopeUserId?: number): Promise<number> =>
  await prisma.revalleInvoiceFile.count({
    where: { AND: [invoiceFiles, financePendingFileWhere, scoped(scopeUserId)] },
  });

/**
 * Notas aguardando a Contabilidade (centro sem validação). O aviso da tela Admin → Perfis usa o mesmo número, sem escopo.
 */
export const countInvoicesPendingAccounting = async (scopeUserId?: number): Promise<number> =>
  await prisma.revalleInvoiceFile.count({
    where: { AND: [invoiceFiles, accountingPendingFileWhere, scoped(scopeUserId)] },
  });

/**
 * Pendências de quem está logado, para o contador do menu. `null` = a pessoa não é desse perfil (o menu não mostra nada);
 * zero = é do perfil e não há nada esperando. Os perfis são lidos do banco a cada pedido. O admin conta todas; os
 * demais, só as das suas unidades (o mesmo da fila que o número abre).
 */
export const getInvoicePendingCounts = async (
  userId: number,
): Promise<{ finance: number | null; accounting: number | null }> => {
  const [isFinance, isAccounting, user] = await Promise.all([
    isFinanceMember(userId),
    isAccountingMember(userId),
    prisma.user.findUnique({ where: { id: userId }, select: { roles: true } }),
  ]);
  const scopeUserId = user && isAdmin(user) ? undefined : userId;

  const [finance, accounting] = await Promise.all([
    isFinance ? countInvoicesPendingFinance(scopeUserId) : null,
    isAccounting ? countInvoicesPendingAccounting(scopeUserId) : null,
  ]);

  return { finance, accounting };
};
