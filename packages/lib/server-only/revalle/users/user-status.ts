import { prisma } from '@documenso/prisma';
import { EnvelopeType, type Prisma, RevalleUserStatusAction, RevalleUserStatusSource } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { enableUser } from '../../user/enable-user';

/**
 * REVALLE (v.26): situação da conta no painel (inativação pela folha, "Mantido ativo pelo TI", zerar autenticador).
 * Todo evento fica em `RevalleUserStatusEvent` com quem fez (`actorId`).
 */

const LIFECYCLE_ACTIONS = [RevalleUserStatusAction.INACTIVATED, RevalleUserStatusAction.REACTIVATED];

/** Ids, entre os dados, cujo último evento de inativação/reativação é a inativação pela folha. */
const hrInactivatedIds = async (userIds?: number[]): Promise<number[]> => {
  const latest = await prisma.revalleUserStatusEvent.findMany({
    where: { action: { in: LIFECYCLE_ACTIONS }, ...(userIds ? { userId: { in: userIds } } : {}) },
    distinct: ['userId'],
    orderBy: [{ userId: 'asc' }, { createdAt: 'desc' }],
    select: { userId: true, action: true, source: true },
  });

  return latest
    .filter(
      (event) =>
        event.action === RevalleUserStatusAction.INACTIVATED && event.source === RevalleUserStatusSource.HR_SYNC,
    )
    .map((event) => event.userId);
};

const assertUserExists = async (userId: number) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });

  if (!user) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'User not found' });
  }
};

export type RevalleUserStatus = {
  disabled: boolean;
  hrInactivated: boolean;
  keepActive: boolean;
};

export const getRevalleUserStatus = async (userId: number): Promise<RevalleUserStatus> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { disabled: true, revalleKeepActive: { select: { userId: true } } },
  });

  if (!user) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'User not found' });
  }

  const hrInactivated = user.disabled && (await hrInactivatedIds([userId])).length > 0;

  return { disabled: user.disabled, hrInactivated, keepActive: Boolean(user.revalleKeepActive) };
};

/** Liga ou desliga "Mantido ativo pelo TI". Só grava evento quando a marca muda. */
export const setRevalleKeepActive = async ({
  userId,
  keepActive,
  actorId,
}: {
  userId: number;
  keepActive: boolean;
  actorId: number;
}) => {
  await assertUserExists(userId);

  await prisma.$transaction(async (tx) => {
    const existing = await tx.revalleUserKeepActive.findUnique({ where: { userId } });

    if (keepActive === Boolean(existing)) {
      return;
    }

    if (keepActive) {
      await tx.revalleUserKeepActive.create({ data: { userId, setById: actorId } });
    } else {
      await tx.revalleUserKeepActive.delete({ where: { userId } });
    }

    await tx.revalleUserStatusEvent.create({
      data: {
        userId,
        action: keepActive ? RevalleUserStatusAction.KEPT_ACTIVE_ON : RevalleUserStatusAction.KEPT_ACTIVE_OFF,
        source: RevalleUserStatusSource.ADMIN,
        actorId,
      },
    });
  });
};

/**
 * Reativar: reativa a conta (o "ativar usuário" do upstream), registra quem reativou e liga "Mantido ativo pelo TI",
 * para a folha não inativar de novo na noite seguinte.
 * `keepActive`: 'always' (botão "Reativar") ou 'ifHrInactivated' (o "Ativar conta" do upstream: só liga a marca quando
 * quem desativou foi a folha; conta desativada à mão pelo TI volta sem a marca).
 * Ordem: a marca antes de reativar. Se algo falha depois, a conta continua desativada (com a marca, inofensiva), e nunca
 * fica ativa sem a marca para a folha desativar de novo.
 */
export const reactivateRevalleUser = async ({
  userId,
  actorId,
  keepActive = 'always',
}: {
  userId: number;
  actorId: number;
  keepActive?: 'always' | 'ifHrInactivated';
}) => {
  await assertUserExists(userId);

  const shouldKeepActive = keepActive === 'always' || (await hrInactivatedIds([userId])).length > 0;

  if (shouldKeepActive) {
    await setRevalleKeepActive({ userId, keepActive: true, actorId });
  }

  await enableUser({ id: userId });

  await prisma.revalleUserStatusEvent.create({
    data: {
      userId,
      action: RevalleUserStatusAction.REACTIVATED,
      source: RevalleUserStatusSource.ADMIN,
      actorId,
    },
  });
};

/** Registro do "Zerar autenticador" (o reset em si é o do upstream). */
export const recordRevalleTotpReset = async ({ userId, actorId }: { userId: number; actorId: number }) => {
  await prisma.revalleUserStatusEvent.create({
    data: {
      userId,
      action: RevalleUserStatusAction.TOTP_RESET,
      source: RevalleUserStatusSource.ADMIN,
      actorId,
    },
  });
};

/** Filtro "Inativados pela folha" da lista de usuários: mesmo formato do `findUsers` do upstream. */
export const findHrInactivatedUsers = async ({
  search = '',
  page = 1,
  perPage = 10,
}: {
  search?: string;
  page?: number;
  perPage?: number;
}) => {
  const ids = await hrInactivatedIds();

  const where: Prisma.UserWhereInput = {
    id: { in: ids },
    disabled: true,
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [users, count] = await Promise.all([
    prisma.user.findMany({
      select: {
        _count: { select: { envelopes: { where: { type: EnvelopeType.DOCUMENT } } } },
        id: true,
        name: true,
        email: true,
        roles: true,
      },
      where,
      orderBy: { id: 'asc' },
      skip: Math.max(page - 1, 0) * perPage,
      take: perPage,
    }),
    prisma.user.count({ where }),
  ]);

  return {
    users: users.map(({ _count, ...user }) => ({ ...user, documentCount: _count.envelopes })),
    totalPages: Math.ceil(count / perPage),
  };
};
