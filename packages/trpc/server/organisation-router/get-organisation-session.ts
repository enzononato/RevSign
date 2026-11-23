import { isCollaboratorContractTeamUrl } from '@documenso/lib/revalle/collaborator-contract-team'; // REVALLE:
import { ensurePersonalOrganisation } from '@documenso/lib/server-only/revalle/personal-organisation'; // REVALLE:
import { isAdmin } from '@documenso/lib/utils/is-admin'; // REVALLE:
import { getHighestOrganisationRoleInGroup } from '@documenso/lib/utils/organisations';
import { buildTeamWhereQuery, extractDerivedTeamSettings, getHighestTeamRoleInGroup } from '@documenso/lib/utils/teams';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import type { TGetOrganisationSessionResponse } from './get-organisation-session.types';
import { ZGetOrganisationSessionResponseSchema } from './get-organisation-session.types';

/**
 * Get all the organisations and teams a user belongs to.
 */
export const getOrganisationSessionRoute = authenticatedProcedure
  .output(ZGetOrganisationSessionResponseSchema)
  .query(async ({ ctx }) => {
    return await getOrganisationSession({ userId: ctx.user.id });
  });

export const getOrganisationSession = async ({
  userId,
  revalleHealed = false, // REVALLE: só uma tentativa de criar a organização pessoal por chamada
}: {
  userId: number;
  revalleHealed?: boolean;
}): Promise<TGetOrganisationSessionResponse> => {
  const organisations = await prisma.organisation.findMany({
    where: {
      members: {
        some: {
          userId,
        },
      },
    },
    include: {
      organisationClaim: true,
      organisationGlobalSettings: true,
      subscription: true,
      groups: {
        where: {
          organisationGroupMembers: {
            some: {
              organisationMember: {
                userId,
              },
            },
          },
        },
      },
      teams: {
        where: buildTeamWhereQuery({ teamId: undefined, userId }),
        include: {
          teamGlobalSettings: true,
          teamEmail: { select: { email: true } },
          teamGroups: {
            where: {
              organisationGroup: {
                organisationGroupMembers: {
                  some: {
                    organisationMember: {
                      userId,
                    },
                  },
                },
              },
            },
            include: {
              organisationGroup: true,
            },
          },
        },
      },
    },
  });

  // REVALLE: conta sem organização ganha a pessoal (uma vez, com trava contra corrida; não vale para conta desativada).
  if (organisations.length === 0 && !revalleHealed && (await ensurePersonalOrganisation({ userId }))) {
    return await getOrganisationSession({ userId, revalleHealed: true });
  }

  // REVALLE: v.22, o time "Contratos para colaboradores" só aparece para administrador do sistema (seletor e menus).
  const revalleHideContractTeams =
    organisations.some((organisation) => organisation.teams.some((team) => isCollaboratorContractTeamUrl(team.url))) &&
    !isAdmin(await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { roles: true } }));

  return organisations.map((organisation) => {
    const { organisationGlobalSettings } = organisation;

    return {
      ...organisation,
      teams: organisation.teams
        .filter((team) => !revalleHideContractTeams || !isCollaboratorContractTeamUrl(team.url)) // REVALLE:
        .map((team) => {
          const derivedSettings = extractDerivedTeamSettings(organisationGlobalSettings, team.teamGlobalSettings);

          return {
            ...team,
            currentTeamRole: getHighestTeamRoleInGroup(team.teamGroups),
            preferences: {
              aiFeaturesEnabled: derivedSettings.aiFeaturesEnabled,
            },
          };
        }),
      currentOrganisationRole: getHighestOrganisationRoleInGroup(organisation.groups),
    };
  });
};
