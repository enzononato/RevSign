import { prisma } from '@documenso/prisma';
import { OrganisationGroupType, OrganisationMemberRole, Prisma, TeamMemberRole } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { generateDatabaseId } from '../../../universal/id';
import { getHighestOrganisationRoleInGroup } from '../../../utils/organisations';
import { addUserToOrganisation } from '../../organisation/accept-organisation-invitation';
import { getUnitOrThrow } from './get-unit';

/** Papéis que o painel dá num time: membro (padrão) ou gerente. Administrador do time fica com o upstream. */
export const UNIT_TEAM_ROLES = [TeamMemberRole.MEMBER, TeamMemberRole.MANAGER] as const;

export type UnitTeamRole = (typeof UNIT_TEAM_ROLES)[number];

/** `role` ausente = mantém o papel atual no time (ou membro, se a pessoa ainda não estiver nele). */
export type UnitTeamChoice = { teamId: number; role?: UnitTeamRole };

const TEAM_ROLE_RANK: Record<TeamMemberRole, number> = { MEMBER: 1, MANAGER: 2, ADMIN: 3 };

const highestTeamRole = (current: TeamMemberRole | undefined, next: TeamMemberRole): TeamMemberRole =>
  current && TEAM_ROLE_RANK[current] >= TEAM_ROLE_RANK[next] ? current : next;

export const USER_SEARCH_LIMIT = 10;

/** Contas existentes por nome ou e-mail, para adicionar à unidade. `isMember` marca quem já está nela. */
export const searchUsersForUnit = async ({ organisationId, query }: { organisationId: string; query: string }) => {
  const text = query.trim();

  if (text.length < 2) {
    return [];
  }

  const users = await prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: text, mode: Prisma.QueryMode.insensitive } },
        { email: { contains: text, mode: Prisma.QueryMode.insensitive } },
      ],
    },
    select: {
      id: true,
      name: true,
      email: true,
      disabled: true,
      organisationMember: { where: { organisationId }, select: { id: true } },
    },
    orderBy: [{ disabled: 'asc' }, { name: 'asc' }, { email: 'asc' }],
    take: USER_SEARCH_LIMIT,
  });

  return users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    disabled: user.disabled,
    isMember: user.organisationMember.length > 0,
  }));
};

/** Grupos internos de cada time da unidade (um por papel), como o upstream cria em `createTeam`. */
const loadTeamRoleGroups = async (organisationId: string) => {
  const teams = await prisma.team.findMany({
    where: { organisationId },
    select: {
      id: true,
      teamGroups: {
        where: { organisationGroup: { type: OrganisationGroupType.INTERNAL_TEAM } },
        select: { organisationGroupId: true, teamRole: true },
      },
    },
  });

  return new Map(
    teams.map((team) => [
      team.id,
      new Map(team.teamGroups.map((group) => [group.teamRole, group.organisationGroupId])),
    ]),
  );
};

const getMemberOrThrow = async (organisationId: string, userId: number) => {
  const member = await prisma.organisationMember.findUnique({
    where: { userId_organisationId: { userId, organisationId } },
    select: { id: true },
  });

  if (!member) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Pessoa não está na unidade.' });
  }

  return member;
};

/**
 * Times da pessoa na unidade: entra nos escolhidos (com o papel escolhido) e sai dos outros. Mexe só nos grupos
 * internos de time (os mesmos que a tela de membros do time usa); o papel na organização não muda. Os documentos que a
 * pessoa enviou continuam dela: quem sai de um time ainda vê o que enviou ou recebeu.
 */
export const setUnitMemberTeams = async ({
  organisationId,
  userId,
  teams,
}: {
  organisationId: string;
  userId: number;
  teams: UnitTeamChoice[];
}) => {
  await getUnitOrThrow(organisationId);

  const member = await getMemberOrThrow(organisationId, userId);
  const roleGroups = await loadTeamRoleGroups(organisationId);

  const allTeamGroupIds = [...roleGroups.values()].flatMap((groups) => [...groups.values()]);
  const teamOfGroup = new Map(
    [...roleGroups].flatMap(([teamId, groups]) =>
      [...groups].map(([role, groupId]) => [groupId, { teamId, role }] as const),
    ),
  );

  for (const choice of teams) {
    if (!roleGroups.has(choice.teamId)) {
      throw new AppError(AppErrorCode.INVALID_BODY, { message: 'Time fora da unidade.' });
    }
  }

  await prisma.$transaction(async (tx) => {
    const current = await tx.organisationGroupMember.findMany({
      where: { organisationMemberId: member.id, groupId: { in: allTeamGroupIds } },
      select: { groupId: true },
    });
    const currentIds = new Set(current.map((row) => row.groupId));

    // Papel atual em cada time (o mais alto, se houver mais de um grupo).
    const currentRoleByTeam = new Map<number, TeamMemberRole>();

    for (const { groupId } of current) {
      const info = teamOfGroup.get(groupId);

      if (info) {
        currentRoleByTeam.set(info.teamId, highestTeamRole(currentRoleByTeam.get(info.teamId), info.role));
      }
    }

    // Time que continua marcado mantém o papel: administrador do time (dado pelo upstream) nunca é rebaixado aqui, e
    // sem papel no pedido fica o papel atual. Desmarcar tira a pessoa do time, qualquer que seja o papel.
    const desiredByTeam = new Map<number, string>();

    for (const choice of teams) {
      const groups = roleGroups.get(choice.teamId);
      const currentRole = currentRoleByTeam.get(choice.teamId);
      const role =
        currentRole === TeamMemberRole.ADMIN
          ? TeamMemberRole.ADMIN
          : (choice.role ?? currentRole ?? TeamMemberRole.MEMBER);
      const groupId = groups?.get(role);

      if (!groupId) {
        throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Grupo do time não encontrado.' });
      }

      desiredByTeam.set(choice.teamId, groupId);
    }

    const desired = new Set(desiredByTeam.values());
    const toRemove = [...currentIds].filter((groupId) => !desired.has(groupId));
    const toAdd = [...desired].filter((groupId) => !currentIds.has(groupId));

    if (toRemove.length > 0) {
      await tx.organisationGroupMember.deleteMany({
        where: { organisationMemberId: member.id, groupId: { in: toRemove } },
      });
    }

    if (toAdd.length > 0) {
      await tx.organisationGroupMember.createMany({
        data: toAdd.map((groupId) => ({
          id: generateDatabaseId('group_member'),
          organisationMemberId: member.id,
          groupId,
        })),
        skipDuplicates: true,
      });
    }
  });
};

/**
 * Adiciona uma conta existente à unidade como MEMBRO da organização (helper do upstream, sem o e-mail de "entrou na
 * organização") e nos times escolhidos. Quem já está na unidade só tem os times atualizados.
 */
export const addUnitMember = async ({
  organisationId,
  userId,
  teams,
}: {
  organisationId: string;
  userId: number;
  teams: UnitTeamChoice[];
}) => {
  await getUnitOrThrow(organisationId);

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, disabled: true } });

  if (!user) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Usuário não encontrado.' });
  }

  if (user.disabled) {
    throw new AppError('REVALLE_USER_DISABLED', { message: 'Conta desativada.', statusCode: 400 });
  }

  const existing = await prisma.organisationMember.findUnique({
    where: { userId_organisationId: { userId, organisationId } },
    select: { id: true },
  });

  if (!existing) {
    const groups = await prisma.organisationGroup.findMany({ where: { organisationId } });

    try {
      await addUserToOrganisation({
        userId,
        organisationId,
        organisationGroups: groups,
        organisationMemberRole: OrganisationMemberRole.MEMBER,
        bypassEmail: true,
      });
    } catch (error) {
      // Dois cliques ao mesmo tempo: a outra chamada já pôs a pessoa na unidade.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
    }
  }

  await setUnitMemberTeams({ organisationId, userId, teams });
};

/**
 * Tira a pessoa da unidade (sai da organização e de todos os times dela). O dono da organização não sai. Os documentos
 * continuam com quem enviou (diferente do upstream, que passa para o dono): a regra "vê o que enviou ou recebeu" segue
 * valendo para quem saiu.
 */
export const removeUnitMember = async ({ organisationId, userId }: { organisationId: string; userId: number }) => {
  const unit = await getUnitOrThrow(organisationId);

  if (unit.ownerUserId === userId) {
    throw new AppError('REVALLE_UNIT_OWNER', { message: 'O dono da unidade não sai.', statusCode: 400 });
  }

  const member = await getMemberOrThrow(organisationId, userId);

  await prisma.organisationMember.delete({ where: { id: member.id } });
};

export type UnitDetail = Awaited<ReturnType<typeof getUnitDetail>>;

/** Unidade aberta: times (com pessoas e documentos) e pessoas (com times, papel e as marcas de acesso). */
export const getUnitDetail = async ({ organisationId }: { organisationId: string }) => {
  const unit = await getUnitOrThrow(organisationId);

  const [teams, members, envelopeCounts] = await Promise.all([
    prisma.team.findMany({
      where: { organisationId },
      select: { id: true, name: true, url: true },
      orderBy: { name: 'asc' },
    }),
    prisma.organisationMember.findMany({
      where: { organisationId },
      select: {
        id: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            disabled: true,
            revalleVisibility: { select: { ownOnly: true } },
            revalleFinanceMember: { select: { userId: true } },
            revalleAccountingMember: { select: { userId: true } },
            revalleUnitScopes: { select: { organisationId: true } },
          },
        },
        organisationGroupMembers: {
          select: {
            group: {
              select: {
                type: true,
                organisationRole: true,
                teamGroups: { select: { teamId: true, teamRole: true } },
              },
            },
          },
        },
      },
    }),
    prisma.envelope.groupBy({
      by: ['teamId'],
      where: { team: { organisationId } },
      _count: { _all: true },
    }),
  ]);

  const envelopeCountByTeam = new Map(envelopeCounts.map((row) => [row.teamId, row._count._all]));

  const memberRows = members
    .map((member) => {
      const groups = member.organisationGroupMembers.map((row) => row.group);
      const organisationRole = getHighestOrganisationRoleInGroup(
        groups.filter((group) => group.type === OrganisationGroupType.INTERNAL_ORGANISATION),
      );

      const teamRoles = new Map<number, TeamMemberRole>();

      for (const group of groups) {
        if (group.type !== OrganisationGroupType.INTERNAL_TEAM) {
          continue;
        }

        for (const teamGroup of group.teamGroups) {
          teamRoles.set(teamGroup.teamId, highestTeamRole(teamRoles.get(teamGroup.teamId), teamGroup.teamRole));
        }
      }

      return {
        organisationMemberId: member.id,
        userId: member.user.id,
        name: member.user.name,
        email: member.user.email,
        disabled: member.user.disabled,
        isOwner: member.user.id === unit.ownerUserId,
        organisationRole,
        teams: [...teamRoles].map(([teamId, role]) => ({ teamId, role })),
        ownOnly: member.user.revalleVisibility?.ownOnly ?? false,
        isFinanceMember: member.user.revalleFinanceMember !== null,
        isAccountingMember: member.user.revalleAccountingMember !== null,
        scopeOrganisationIds: member.user.revalleUnitScopes.map((scope) => scope.organisationId),
        joinedAt: member.createdAt,
      };
    })
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, 'pt-BR'));

  const teamRows = teams.map((team) => ({
    id: team.id,
    name: team.name,
    url: team.url,
    memberCount: memberRows.filter((member) => member.teams.some((choice) => choice.teamId === team.id)).length,
    envelopeCount: envelopeCountByTeam.get(team.id) ?? 0,
  }));

  return {
    unit: { organisationId: unit.id, name: unit.name, hrUnitName: unit.hrUnitName },
    teams: teamRows,
    members: memberRows,
  };
};
