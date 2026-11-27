import { prisma } from '@documenso/prisma';

import { PROTECTED_TEAM_URLS } from '../../../constants/teams';
import { AppError, AppErrorCode } from '../../../errors/app-error';
import { isReservedCollaboratorContractTeamUrl } from '../../../revalle/collaborator-contract-team';
import { alphaid } from '../../../universal/id';
import { createTeam } from '../../team/create-team';
import { deleteTeam } from '../../team/delete-team';
import { getColaboradoresRepository, type UnidadeSetor } from '../colaboradores/repository';
import { revalleErrorCode } from '../error-code';
import { getUnitOrThrow } from './get-unit';
import { foldName, setoresForUnit, slugifyTeamUrl } from './names';

export const TEAM_NAME_MAX = 60;

/** Pares unidade × setor da base do RH (só leitura). Sem base configurada ou fora do ar: null (nada é criado). */
export const loadHrUnidadeSetores = async (): Promise<UnidadeSetor[] | null> => {
  try {
    const repository = getColaboradoresRepository();

    if (!repository) {
      return null;
    }

    return await repository.findDistinctUnidadeSetores();
  } catch (error) {
    // Só o código do erro: a mensagem pode trazer dados da conexão.
    console.error(`[revalle] Unidades: base do RH indisponível (${revalleErrorCode(error)}).`);

    return null;
  }
};

const isTeamUrlFree = async (url: string) => {
  if (url.length < 3 || PROTECTED_TEAM_URLS.includes(url) || isReservedCollaboratorContractTeamUrl(url)) {
    return false;
  }

  const [team, organisation] = await Promise.all([
    prisma.team.findFirst({ where: { url }, select: { id: true } }),
    prisma.organisation.findFirst({ where: { url }, select: { id: true } }),
  ]);

  return !team && !organisation;
};

/** Endereço legível e único: "juazeiro-comercial", "juazeiro-comercial-2"... (sorteado se tudo estiver ocupado). */
const buildTeamUrl = async (unitName: string, teamName: string) => {
  const base = slugifyTeamUrl(`${unitName} ${teamName}`) || 'time';

  for (let attempt = 1; attempt <= 20; attempt++) {
    const url = attempt === 1 ? base : `${base}-${attempt}`;

    if (await isTeamUrlFree(url)) {
      return url;
    }
  }

  return `${base.slice(0, 20)}-${alphaid(6)}`;
};

const normalizeTeamName = (name: string) => name.replace(/\s+/g, ' ').trim();

const createTeamInUnit = async (unit: { id: string; name: string; ownerUserId: number }, teamName: string) => {
  const teamUrl = await buildTeamUrl(unit.name, teamName);

  // Helper do upstream: grupos internos do time (Admin, Gerente, Membro) e configurações padrão. Sem herdar os membros
  // da organização: cada pessoa só entra nos times que o TI escolher. O dono da organização dá a permissão.
  await createTeam({
    userId: unit.ownerUserId,
    teamName,
    teamUrl,
    organisationId: unit.id,
    inheritMembers: false,
  });

  const team = await prisma.team.findFirstOrThrow({ where: { url: teamUrl }, select: { id: true } });

  return team.id;
};

const existingTeamKeys = async (organisationId: string) => {
  const teams = await prisma.team.findMany({ where: { organisationId }, select: { name: true } });

  return new Set(teams.map((team) => foldName(team.name)));
};

/** Cria um time na unidade. Nome repetido na mesma unidade (sem acento nem maiúsculas) é recusado. */
export const createUnitTeam = async ({ organisationId, name }: { organisationId: string; name: string }) => {
  const unit = await getUnitOrThrow(organisationId);
  const teamName = normalizeTeamName(name);

  if (!teamName) {
    throw new AppError(AppErrorCode.INVALID_BODY, { message: 'Nome do time vazio.' });
  }

  if ((await existingTeamKeys(organisationId)).has(foldName(teamName))) {
    throw new AppError('REVALLE_TEAM_EXISTS', { message: 'Time já existe na unidade.', statusCode: 409 });
  }

  return { teamId: await createTeamInUnit(unit, teamName) };
};

const createMissingTeams = async (
  unit: { id: string; name: string; ownerUserId: number; hrUnitName: string },
  pairs: UnidadeSetor[],
) => {
  const keys = await existingTeamKeys(unit.id);
  const created: string[] = [];

  for (const setor of setoresForUnit(pairs, unit.hrUnitName)) {
    const teamName = setor.slice(0, TEAM_NAME_MAX);

    if (keys.has(foldName(teamName))) {
      continue;
    }

    await createTeamInUnit(unit, teamName);
    keys.add(foldName(teamName));
    created.push(teamName);
  }

  return created;
};

/**
 * "Criar times a partir dos setores do RH": um time por setor distinto da unidade, sem repetir os que já existem.
 * Base do RH fora do ar: não cria nada e avisa (`hrAvailable: false`).
 */
export const createTeamsFromHr = async ({ organisationId }: { organisationId: string }) => {
  const unit = await getUnitOrThrow(organisationId);
  const pairs = await loadHrUnidadeSetores();

  if (!pairs) {
    return { hrAvailable: false, created: [] as string[], setorCount: 0 };
  }

  const created = await createMissingTeams(unit, pairs);

  return { hrAvailable: true, created, setorCount: setoresForUnit(pairs, unit.hrUnitName).length };
};

/** Mesma regra de `createTeamsFromHr`, para várias unidades com uma leitura só da base do RH. */
export const createTeamsFromHrForUnits = async ({
  organisationIds,
  pairs,
}: {
  organisationIds: string[];
  pairs: UnidadeSetor[];
}) => {
  let created = 0;

  for (const organisationId of organisationIds) {
    const unit = await getUnitOrThrow(organisationId);

    created += (await createMissingTeams(unit, pairs)).length;
  }

  return { created };
};

/** O time precisa ser de uma organização marcada como unidade (o painel não mexe em times de fora). */
export const getUnitTeamOrThrow = async (teamId: number) => {
  const team = await prisma.team.findFirst({
    where: { id: teamId, organisation: { revalleUnit: { isNot: null } } },
    select: { id: true, name: true, organisationId: true, organisation: { select: { ownerUserId: true } } },
  });

  if (!team) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Time não encontrado.' });
  }

  return team;
};

export const renameUnitTeam = async ({ teamId, name }: { teamId: number; name: string }) => {
  const team = await getUnitTeamOrThrow(teamId);
  const teamName = normalizeTeamName(name);

  if (!teamName) {
    throw new AppError(AppErrorCode.INVALID_BODY, { message: 'Nome do time vazio.' });
  }

  const others = await prisma.team.findMany({
    where: { organisationId: team.organisationId, id: { not: teamId } },
    select: { name: true },
  });

  if (others.some((other) => foldName(other.name) === foldName(teamName))) {
    throw new AppError('REVALLE_TEAM_EXISTS', { message: 'Time já existe na unidade.', statusCode: 409 });
  }

  // Só o nome: o endereço (/t/...) continua o mesmo, para não quebrar links salvos.
  await prisma.team.update({ where: { id: teamId }, data: { name: teamName } });
};

/** Remove o time pelo helper do upstream. Time com qualquer documento ou modelo (até na lixeira) não sai. */
export const deleteUnitTeam = async ({ teamId }: { teamId: number }) => {
  const team = await getUnitTeamOrThrow(teamId);
  const envelopeCount = await prisma.envelope.count({ where: { teamId } });

  if (envelopeCount > 0) {
    throw new AppError('REVALLE_TEAM_HAS_DOCUMENTS', {
      message: 'Time com documentos não pode ser removido.',
      statusCode: 409,
    });
  }

  await deleteTeam({ userId: team.organisation.ownerUserId, teamId });
};
