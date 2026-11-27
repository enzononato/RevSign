import { listProfileScopes, setUserOwnOnly, setUserUnitScope } from '@documenso/lib/server-only/revalle/units/access';
import {
  addUnitMember,
  getUnitDetail,
  removeUnitMember,
  searchUsersForUnit,
  setUnitMemberTeams,
} from '@documenso/lib/server-only/revalle/units/members';
import {
  createTeamsFromHr,
  createUnitTeam,
  deleteUnitTeam,
  renameUnitTeam,
} from '@documenso/lib/server-only/revalle/units/teams';
import {
  createDefaultUnits,
  createUnit,
  findMissingDefaultUnits,
  listUnits,
  renameUnit,
} from '@documenso/lib/server-only/revalle/units/units';
import { z } from 'zod';

import { router } from '../../trpc';
import { financeAdminProcedure } from '../finance/admin-procedure';
import {
  ZUnitsAddMemberRequestSchema,
  ZUnitsCreateDefaultsResponseSchema,
  ZUnitsCreateRequestSchema,
  ZUnitsCreateResponseSchema,
  ZUnitsCreateTeamRequestSchema,
  ZUnitsCreateTeamResponseSchema,
  ZUnitsCreateTeamsFromHrRequestSchema,
  ZUnitsCreateTeamsFromHrResponseSchema,
  ZUnitsDeleteTeamRequestSchema,
  ZUnitsGetRequestSchema,
  ZUnitsGetResponseSchema,
  ZUnitsListProfilesResponseSchema,
  ZUnitsListResponseSchema,
  ZUnitsRemoveMemberRequestSchema,
  ZUnitsRenameRequestSchema,
  ZUnitsRenameTeamRequestSchema,
  ZUnitsSearchUsersRequestSchema,
  ZUnitsSearchUsersResponseSchema,
  ZUnitsSetMemberTeamsRequestSchema,
  ZUnitsSetOwnOnlyRequestSchema,
  ZUnitsSetScopeRequestSchema,
} from './schema';

/**
 * REVALLE (v.26): Admin → "Unidades e times". Só o admin do sistema: sem sessão 401, logado sem ADMIN 403 (o mesmo
 * procedimento das telas de admin do Financeiro). Nada de nome, e-mail ou busca nos logs.
 */
const procedure = financeAdminProcedure;
const ZVoid = z.void();

export const unitsRouter = router({
  list: procedure.output(ZUnitsListResponseSchema).query(async () => {
    const [units, missingDefaultUnits] = await Promise.all([listUnits(), findMissingDefaultUnits()]);

    return { units, missingDefaultUnits };
  }),

  create: procedure
    .input(ZUnitsCreateRequestSchema)
    .output(ZUnitsCreateResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organisationId } = await createUnit({
        name: input.name,
        hrUnitName: input.hrUnitName,
        actorId: ctx.user.id,
      });

      if (!input.createTeamsFromHr) {
        return { organisationId, teamsCreated: 0, hrAvailable: null };
      }

      const teams = await createTeamsFromHr({ organisationId });

      return { organisationId, teamsCreated: teams.created.length, hrAvailable: teams.hrAvailable };
    }),

  createDefaults: procedure
    .output(ZUnitsCreateDefaultsResponseSchema)
    .mutation(async ({ ctx }) => await createDefaultUnits({ actorId: ctx.user.id })),

  rename: procedure
    .input(ZUnitsRenameRequestSchema)
    .output(ZVoid)
    .mutation(async ({ input }) => {
      await renameUnit(input);
    }),

  get: procedure
    .input(ZUnitsGetRequestSchema)
    .output(ZUnitsGetResponseSchema)
    .query(async ({ input }) => await getUnitDetail(input)),

  createTeamsFromHr: procedure
    .input(ZUnitsCreateTeamsFromHrRequestSchema)
    .output(ZUnitsCreateTeamsFromHrResponseSchema)
    .mutation(async ({ input }) => await createTeamsFromHr(input)),

  createTeam: procedure
    .input(ZUnitsCreateTeamRequestSchema)
    .output(ZUnitsCreateTeamResponseSchema)
    .mutation(async ({ input }) => await createUnitTeam(input)),

  renameTeam: procedure
    .input(ZUnitsRenameTeamRequestSchema)
    .output(ZVoid)
    .mutation(async ({ input }) => {
      await renameUnitTeam(input);
    }),

  deleteTeam: procedure
    .input(ZUnitsDeleteTeamRequestSchema)
    .output(ZVoid)
    .mutation(async ({ input }) => {
      await deleteUnitTeam(input);
    }),

  searchUsers: procedure
    .input(ZUnitsSearchUsersRequestSchema)
    .output(ZUnitsSearchUsersResponseSchema)
    .query(async ({ input }) => ({ users: await searchUsersForUnit(input) })),

  addMember: procedure
    .input(ZUnitsAddMemberRequestSchema)
    .output(ZVoid)
    .mutation(async ({ input }) => {
      await addUnitMember(input);
    }),

  setMemberTeams: procedure
    .input(ZUnitsSetMemberTeamsRequestSchema)
    .output(ZVoid)
    .mutation(async ({ input }) => {
      await setUnitMemberTeams(input);
    }),

  removeMember: procedure
    .input(ZUnitsRemoveMemberRequestSchema)
    .output(ZVoid)
    .mutation(async ({ input }) => {
      await removeUnitMember(input);
    }),

  setOwnOnly: procedure
    .input(ZUnitsSetOwnOnlyRequestSchema)
    .output(ZVoid)
    .mutation(async ({ input, ctx }) => {
      await setUserOwnOnly({ ...input, actorId: ctx.user.id });
    }),

  setScope: procedure
    .input(ZUnitsSetScopeRequestSchema)
    .output(ZVoid)
    .mutation(async ({ input, ctx }) => {
      await setUserUnitScope({ ...input, actorId: ctx.user.id });
    }),

  listProfiles: procedure
    .output(ZUnitsListProfilesResponseSchema)
    .query(async () => ({ users: await listProfileScopes() })),
});
