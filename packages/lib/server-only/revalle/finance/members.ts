import { prisma } from '@documenso/prisma';
import { Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';

/** Linhas da tela Admin → Financeiro (quem é membro vem antes; o resto é achado pela busca). */
export const FINANCE_USERS_LIMIT = 100;

export type FinanceUserRow = { id: number; name: string | null; email: string; isFinance: boolean };

/**
 * Perfil Financeiro (Fase 6): tabela própria `RevalleFinanceMember`, marcada pelo admin. Lido do banco a cada pedido,
 * sem cache: quem sai do perfil perde a visão e as ações na hora.
 */
export const isFinanceMember = async (userId: number): Promise<boolean> => {
  const member = await prisma.revalleFinanceMember.findUnique({ where: { userId }, select: { userId: true } });

  return member !== null;
};

/** Quantos membros recebem os avisos (contas desativadas ficam de fora, como em `listFinanceMemberEmails`). */
export const countFinanceMembers = async (): Promise<number> =>
  await prisma.revalleFinanceMember.count({ where: { user: { disabled: false } } });

/** E-mails para os avisos do Financeiro: todos os membros, menos contas desativadas. */
export const listFinanceMemberEmails = async (): Promise<string[]> => {
  const members = await prisma.revalleFinanceMember.findMany({
    where: { user: { disabled: false } },
    orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
    select: { user: { select: { email: true } } },
  });

  return members.map((member) => member.user.email);
};

/** Marca ou desmarca. Idempotente: marcar quem já é membro mantém quem marcou primeiro; desmarcar quem não é não falha. */
export const setFinanceMember = async ({
  userId,
  member,
  actorId,
}: {
  userId: number;
  member: boolean;
  actorId: number;
}): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });

  if (!user) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Usuário não encontrado.' });
  }

  if (member) {
    // ON CONFLICT DO NOTHING: dois cliques ao mesmo tempo não dão erro de chave duplicada.
    await prisma.revalleFinanceMember.createMany({ data: [{ userId, addedById: actorId }], skipDuplicates: true });

    return;
  }

  await prisma.revalleFinanceMember.deleteMany({ where: { userId } });
};

/** Usuários para a tela do admin, com busca por nome ou e-mail (sem diferenciar maiúsculas). Membros primeiro. */
export const findFinanceUsers = async ({ query }: { query?: string }): Promise<FinanceUserRow[]> => {
  const text = query?.trim();

  const where: Prisma.UserWhereInput = text
    ? {
        OR: [
          { name: { contains: text, mode: Prisma.QueryMode.insensitive } },
          { email: { contains: text, mode: Prisma.QueryMode.insensitive } },
        ],
      }
    : {};

  const select = { id: true, name: true, email: true } satisfies Prisma.UserSelect;
  const orderBy: Prisma.UserOrderByWithRelationInput[] = [{ name: 'asc' }, { email: 'asc' }];

  const members = await prisma.user.findMany({
    where: { ...where, revalleFinanceMember: { isNot: null } },
    orderBy,
    take: FINANCE_USERS_LIMIT,
    select,
  });

  const others =
    members.length < FINANCE_USERS_LIMIT
      ? await prisma.user.findMany({
          where: { ...where, revalleFinanceMember: { is: null } },
          orderBy,
          take: FINANCE_USERS_LIMIT - members.length,
          select,
        })
      : [];

  return [
    ...members.map((user) => ({ ...user, isFinance: true })),
    ...others.map((user) => ({ ...user, isFinance: false })),
  ];
};
