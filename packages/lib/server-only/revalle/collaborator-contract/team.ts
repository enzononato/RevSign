import { prisma } from '@documenso/prisma';
import { OrganisationType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import {
  COLLABORATOR_CONTRACT_TEAM_NAME,
  collaboratorContractTeamUrl,
} from '../../../revalle/collaborator-contract-team';
import { buildTeamWhereQuery } from '../../../utils/teams';
import { createTeam } from '../../team/create-team';
import { ensurePersonalOrganisation } from '../personal-organisation';

const findTeam = async (userId: number) =>
  await prisma.team.findFirst({
    where: { url: collaboratorContractTeamUrl(userId), ...buildTeamWhereQuery({ teamId: undefined, userId }) },
    select: { id: true },
  });

const findPersonalOrganisationId = async (userId: number) =>
  (
    await prisma.organisation.findFirst({
      where: { ownerUserId: userId, type: OrganisationType.PERSONAL, members: { some: { userId } } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
  )?.id ?? null;

/**
 * O time "Contratos para colaboradores" do admin, criado na primeira vez na organização pessoal dele (só os
 * administradores dessa organização entram, sem herdar os membros). Duas chamadas ao mesmo tempo: a segunda esbarra no
 * `url` único e devolve o time da primeira.
 */
export const ensureCollaboratorContractTeam = async (userId: number): Promise<number> => {
  const existing = await findTeam(userId);

  if (existing) {
    return existing.id;
  }

  let organisationId = await findPersonalOrganisationId(userId);

  if (!organisationId && (await ensurePersonalOrganisation({ userId }))) {
    organisationId = await findPersonalOrganisationId(userId);
  }

  if (!organisationId) {
    const message = 'Sua conta não tem a organização pessoal para guardar os contratos.';

    throw new AppError(AppErrorCode.INVALID_REQUEST, { message, userMessage: message, statusCode: 400 });
  }

  try {
    await createTeam({
      userId,
      teamName: COLLABORATOR_CONTRACT_TEAM_NAME,
      teamUrl: collaboratorContractTeamUrl(userId),
      organisationId,
      inheritMembers: false,
    });
  } catch (error) {
    if (!(error instanceof AppError && error.code === AppErrorCode.ALREADY_EXISTS)) {
      throw error;
    }
  }

  const created = await findTeam(userId);

  if (!created) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Collaborator contract team not found after creation' });
  }

  return created.id;
};
