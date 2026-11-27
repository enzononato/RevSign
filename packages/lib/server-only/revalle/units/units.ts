import { prisma } from '@documenso/prisma';
import { OrganisationType, Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { INTERNAL_CLAIM_ID } from '../../../types/subscription';
import { createOrganisation } from '../../organisation/create-organisation';
import { getSubscriptionClaim } from '../../subscription/get-subscription-claim';
import { getUnitOrThrow } from './get-unit';
import { foldName, REVALLE_DEFAULT_UNITS } from './names';
import { createTeamsFromHrForUnits, loadHrUnidadeSetores } from './teams';

export const UNIT_NAME_MAX = 80;

export type UnitListRow = {
  organisationId: string;
  name: string;
  hrUnitName: string;
  teamCount: number;
  memberCount: number;
  createdAt: Date;
};

/** Lista das unidades (nome, times e pessoas), na ordem das 7 e depois por nome. */
export const listUnits = async (): Promise<UnitListRow[]> => {
  const units = await prisma.revalleUnit.findMany({
    select: {
      hrUnitName: true,
      createdAt: true,
      organisation: {
        select: { id: true, name: true, _count: { select: { teams: true, members: true } } },
      },
    },
  });

  const order = (hrUnitName: string) => {
    const index = REVALLE_DEFAULT_UNITS.findIndex((name) => foldName(name) === foldName(hrUnitName));

    return index === -1 ? REVALLE_DEFAULT_UNITS.length : index;
  };

  return units
    .map((unit) => ({
      organisationId: unit.organisation.id,
      name: unit.organisation.name,
      hrUnitName: unit.hrUnitName,
      teamCount: unit.organisation._count.teams,
      memberCount: unit.organisation._count.members,
      createdAt: unit.createdAt,
    }))
    .sort((a, b) => order(a.hrUnitName) - order(b.hrUnitName) || a.name.localeCompare(b.name, 'pt-BR'));
};

/** Quais das 7 unidades ainda não existem (pela chave do RH, sem acento nem maiúsculas). */
export const findMissingDefaultUnits = async (): Promise<string[]> => {
  const existing = await prisma.revalleUnit.findMany({ select: { hrUnitName: true } });
  const keys = new Set(existing.map((unit) => foldName(unit.hrUnitName)));

  return REVALLE_DEFAULT_UNITS.filter((name) => !keys.has(foldName(name)));
};

const findUnitByHrName = async (hrUnitName: string) =>
  await prisma.revalleUnit.findFirst({
    where: { hrUnitName: { equals: hrUnitName.trim(), mode: Prisma.QueryMode.insensitive } },
    select: { organisationId: true },
  });

/**
 * Cria a organização pelo helper do upstream (grupos de papéis, configurações e claim iguais aos de qualquer
 * organização; o admin que cria vira o dono) e marca como unidade. A chave do RH é única: duas unidades com o mesmo
 * nome do RH, ou dois cliques ao mesmo tempo, não criam duas.
 */
export const createUnit = async ({
  name,
  hrUnitName,
  actorId,
}: {
  name: string;
  hrUnitName?: string;
  actorId: number;
}): Promise<{ organisationId: string }> => {
  const displayName = name.replace(/\s+/g, ' ').trim();
  const hrKey = (hrUnitName ?? displayName).replace(/\s+/g, ' ').trim();

  if (!displayName || !hrKey) {
    throw new AppError(AppErrorCode.INVALID_BODY, { message: 'Nome da unidade vazio.' });
  }

  if (await findUnitByHrName(hrKey)) {
    throw new AppError('REVALLE_UNIT_EXISTS', { message: 'Unidade já existe.', statusCode: 409 });
  }

  const claim = await getSubscriptionClaim(INTERNAL_CLAIM_ID.FREE);

  const organisation = await createOrganisation({
    userId: actorId,
    name: displayName,
    type: OrganisationType.ORGANISATION,
    claim,
  });

  try {
    await prisma.revalleUnit.create({ data: { organisationId: organisation.id, hrUnitName: hrKey } });
  } catch (error) {
    // Outro pedido marcou a mesma chave do RH no meio: desfaz a organização recém-criada (ainda vazia).
    await prisma.organisation.delete({ where: { id: organisation.id } }).catch(() => undefined);

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError('REVALLE_UNIT_EXISTS', { message: 'Unidade já existe.', statusCode: 409 });
    }

    throw error;
  }

  return { organisationId: organisation.id };
};

/**
 * "Criar as 7 unidades": cria as que faltam (idempotente pela chave do RH) e, em todas as 7, os times dos setores do RH
 * que ainda não existem. Base do RH fora do ar: as unidades nascem sem times e o botão pode ser usado de novo depois.
 */
export const createDefaultUnits = async ({ actorId }: { actorId: number }) => {
  const created: string[] = [];
  const existing: string[] = [];
  const organisationIds: string[] = [];

  for (const name of REVALLE_DEFAULT_UNITS) {
    const found = await findUnitByHrName(name);

    if (found) {
      existing.push(name);
      organisationIds.push(found.organisationId);
      continue;
    }

    try {
      const { organisationId } = await createUnit({ name, hrUnitName: name, actorId });

      created.push(name);
      organisationIds.push(organisationId);
    } catch (error) {
      if (error instanceof AppError && error.code === 'REVALLE_UNIT_EXISTS') {
        const raced = await findUnitByHrName(name);

        existing.push(name);

        if (raced) {
          organisationIds.push(raced.organisationId);
        }

        continue;
      }

      throw error;
    }
  }

  const pairs = await loadHrUnidadeSetores();
  const teams = pairs ? await createTeamsFromHrForUnits({ organisationIds, pairs }) : { created: 0 };

  return { created, existing, teamsCreated: teams.created, hrAvailable: pairs !== null };
};

/** Renomeia a unidade (só o nome da organização; a chave do RH e o escopo do Financeiro seguem o id). */
export const renameUnit = async ({ organisationId, name }: { organisationId: string; name: string }) => {
  await getUnitOrThrow(organisationId);

  const displayName = name.replace(/\s+/g, ' ').trim();

  if (!displayName) {
    throw new AppError(AppErrorCode.INVALID_BODY, { message: 'Nome da unidade vazio.' });
  }

  await prisma.organisation.update({ where: { id: organisationId }, data: { name: displayName } });
};
