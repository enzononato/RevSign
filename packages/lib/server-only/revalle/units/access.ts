import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../../errors/app-error';

const assertUserExists = async (userId: number) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });

  if (!user) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Usuário não encontrado.' });
  }
};

/** "Ver só o que enviou ou recebeu para assinar": liga ou desliga para a pessoa (vale em todos os times dela). */
export const setUserOwnOnly = async ({
  userId,
  ownOnly,
  actorId,
}: {
  userId: number;
  ownOnly: boolean;
  actorId: number;
}) => {
  await assertUserExists(userId);

  await prisma.revalleUserVisibility.upsert({
    where: { userId },
    create: { userId, ownOnly, updatedById: actorId },
    update: { ownOnly, updatedById: actorId },
  });
};

/**
 * Unidades que a pessoa do Financeiro ou da Contabilidade cobre (troca a lista inteira). Só aceita organizações
 * marcadas como unidade. Lista vazia = não vê nota nenhuma.
 */
export const setUserUnitScope = async ({
  userId,
  organisationIds,
  actorId,
}: {
  userId: number;
  organisationIds: string[];
  actorId: number;
}) => {
  await assertUserExists(userId);

  const wanted = [...new Set(organisationIds)];

  const units = await prisma.revalleUnit.findMany({
    where: { organisationId: { in: wanted } },
    select: { organisationId: true },
  });

  if (units.length !== wanted.length) {
    throw new AppError(AppErrorCode.INVALID_BODY, { message: 'Unidade não encontrada.' });
  }

  await prisma.$transaction(async (tx) => {
    await tx.revalleUnitScope.deleteMany({ where: { userId, organisationId: { notIn: wanted } } });

    if (wanted.length > 0) {
      await tx.revalleUnitScope.createMany({
        data: wanted.map((organisationId) => ({ userId, organisationId, createdById: actorId })),
        skipDuplicates: true,
      });
    }
  });
};

/** Quem é do Financeiro ou da Contabilidade, com as unidades que cobre e a marca "ver só o seu". */
export const listProfileScopes = async () => {
  const users = await prisma.user.findMany({
    where: {
      OR: [{ revalleFinanceMember: { isNot: null } }, { revalleAccountingMember: { isNot: null } }],
    },
    select: {
      id: true,
      name: true,
      email: true,
      disabled: true,
      revalleFinanceMember: { select: { userId: true } },
      revalleAccountingMember: { select: { userId: true } },
      revalleVisibility: { select: { ownOnly: true } },
      revalleUnitScopes: { select: { organisationId: true } },
    },
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
    take: 200,
  });

  return users.map((user) => ({
    userId: user.id,
    name: user.name,
    email: user.email,
    disabled: user.disabled,
    isFinanceMember: user.revalleFinanceMember !== null,
    isAccountingMember: user.revalleAccountingMember !== null,
    ownOnly: user.revalleVisibility?.ownOnly ?? false,
    scopeOrganisationIds: user.revalleUnitScopes.map((scope) => scope.organisationId),
  }));
};
