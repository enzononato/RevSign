import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { isAdmin } from '../../../utils/is-admin';

/**
 * v.26: a unidade da nota é a organização do time pelo qual ela foi enviada. Quem é do Financeiro ou da Contabilidade (sem
 * ser admin) só enxerga, como perfil, as notas das unidades do seu `RevalleUnitScope`. Sem escopo, nada. A organização
 * precisa ser unidade (`RevalleUnit`): a nota antiga do espaço pessoal nunca entra, mesmo com uma linha de escopo errada
 * apontando para uma organização pessoal. Ela fica só com o admin e com quem enviou (e com quem assina, como hoje).
 *
 * É o único filtro de escopo: a lista, as filas, os contadores, a planilha, a página da nota e as ações leem este.
 */
export const invoiceScopeWhere = (userId: number) =>
  ({
    team: { organisation: { revalleUnit: { isNot: null }, revalleUnitScopes: { some: { userId } } } },
  }) satisfies Prisma.EnvelopeWhereInput;

export const isInvoiceInUserScope = async ({ envelopeId, userId }: { envelopeId: string; userId: number }) =>
  (await prisma.envelope.count({ where: { id: envelopeId, ...invoiceScopeWhere(userId) } })) > 0;

/**
 * As ações e os cartões do Financeiro e da Contabilidade: nota de fora das unidades da pessoa = 404, sem revelar que
 * existe. O admin não tem escopo (vê e age em todas).
 */
export const assertInvoiceInUserScope = async ({ envelopeId, userId }: { envelopeId: string; userId: number }) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { roles: true } });

  if (user && isAdmin(user)) {
    return;
  }

  if (!user || !(await isInvoiceInUserScope({ envelopeId, userId }))) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Nota fiscal não encontrada.' });
  }
};
