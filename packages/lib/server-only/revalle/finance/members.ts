import { prisma } from '@documenso/prisma';
import { Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';

/** Linhas da tela Admin → Perfis (quem tem algum perfil vem antes; o resto é achado pela busca). */
export const PROFILE_USERS_LIMIT = 100;

/** Uma pessoa por linha, com a marca de cada perfil (a mesma pessoa pode ter os dois). */
export type ProfileUserRow = {
  id: number;
  name: string | null;
  email: string;
  isFinanceMember: boolean;
  isAccountingMember: boolean;
};

/**
 * Perfil Financeiro (Fase 6): tabela própria `RevalleFinanceMember`, marcada pelo admin. Lido do banco a cada pedido,
 * sem cache: quem sai do perfil perde a visão e as ações na hora.
 */
export const isFinanceMember = async (userId: number): Promise<boolean> => {
  const member = await prisma.revalleFinanceMember.findUnique({ where: { userId }, select: { userId: true } });

  return member !== null;
};

/** Quantos membros o Financeiro tem (contas desativadas ficam de fora); zero faz a tela do admin avisar. */
export const countFinanceMembers = async (): Promise<number> =>
  await prisma.revalleFinanceMember.count({ where: { user: { disabled: false } } });

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

/**
 * Usuários para a tela Admin → Perfis, com busca por nome ou e-mail (sem diferenciar maiúsculas). Quem é do Financeiro
 * ou da Contabilidade vem primeiro.
 */
export const findProfileUsers = async ({ query }: { query?: string }): Promise<ProfileUserRow[]> => {
  const text = query?.trim();

  const search: Prisma.UserWhereInput = text
    ? {
        OR: [
          { name: { contains: text, mode: Prisma.QueryMode.insensitive } },
          { email: { contains: text, mode: Prisma.QueryMode.insensitive } },
        ],
      }
    : {};

  const select = {
    id: true,
    name: true,
    email: true,
    revalleFinanceMember: { select: { userId: true } },
    revalleAccountingMember: { select: { userId: true } },
  } satisfies Prisma.UserSelect;
  const orderBy: Prisma.UserOrderByWithRelationInput[] = [{ name: 'asc' }, { email: 'asc' }];

  const members = await prisma.user.findMany({
    where: {
      AND: [search, { OR: [{ revalleFinanceMember: { isNot: null } }, { revalleAccountingMember: { isNot: null } }] }],
    },
    orderBy,
    take: PROFILE_USERS_LIMIT,
    select,
  });

  const others =
    members.length < PROFILE_USERS_LIMIT
      ? await prisma.user.findMany({
          where: { AND: [search, { revalleFinanceMember: { is: null } }, { revalleAccountingMember: { is: null } }] },
          orderBy,
          take: PROFILE_USERS_LIMIT - members.length,
          select,
        })
      : [];

  return [...members, ...others].map(({ revalleFinanceMember, revalleAccountingMember, ...user }) => ({
    ...user,
    isFinanceMember: revalleFinanceMember !== null,
    isAccountingMember: revalleAccountingMember !== null,
  }));
};
