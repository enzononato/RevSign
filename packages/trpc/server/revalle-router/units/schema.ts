import { TeamMemberRole } from '@prisma/client';
import { z } from 'zod';

const ZOrganisationId = z.string().min(1).max(64);
const ZUnitName = z.string().trim().min(1).max(80);
const ZTeamName = z.string().trim().min(1).max(60);
const ZTeamChoices = z
  .array(
    z.object({
      teamId: z.number().int().positive(),
      /** Ausente: mantém o papel atual (membro para quem entra). Administrador do time nunca é rebaixado aqui. */
      role: z.enum([TeamMemberRole.MEMBER, TeamMemberRole.MANAGER]).optional(),
    }),
  )
  .max(100);

export const ZUnitsListResponseSchema = z.object({
  units: z.array(
    z.object({
      organisationId: z.string(),
      name: z.string(),
      hrUnitName: z.string(),
      teamCount: z.number(),
      memberCount: z.number(),
      createdAt: z.date(),
    }),
  ),
  /** Quais das 7 unidades ainda não existem. */
  missingDefaultUnits: z.array(z.string()),
});

export const ZUnitsCreateRequestSchema = z.object({
  name: ZUnitName,
  /** Nome da unidade na base do RH (padrão: o próprio nome). É a chave única. */
  hrUnitName: ZUnitName.optional(),
  /** Já cria os times dos setores do RH. */
  createTeamsFromHr: z.boolean().default(false),
});

export const ZUnitsCreateResponseSchema = z.object({
  organisationId: z.string(),
  teamsCreated: z.number(),
  hrAvailable: z.boolean().nullable(),
});

export const ZUnitsCreateDefaultsResponseSchema = z.object({
  created: z.array(z.string()),
  existing: z.array(z.string()),
  teamsCreated: z.number(),
  hrAvailable: z.boolean(),
});

export const ZUnitsRenameRequestSchema = z.object({ organisationId: ZOrganisationId, name: ZUnitName });

export const ZUnitsGetRequestSchema = z.object({ organisationId: ZOrganisationId });

export const ZUnitsGetResponseSchema = z.object({
  unit: z.object({ organisationId: z.string(), name: z.string(), hrUnitName: z.string() }),
  teams: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      url: z.string(),
      memberCount: z.number(),
      envelopeCount: z.number(),
    }),
  ),
  members: z.array(
    z.object({
      organisationMemberId: z.string(),
      userId: z.number(),
      name: z.string().nullable(),
      email: z.string(),
      disabled: z.boolean(),
      isOwner: z.boolean(),
      organisationRole: z.enum(['ADMIN', 'MANAGER', 'MEMBER']),
      teams: z.array(z.object({ teamId: z.number(), role: z.enum(['ADMIN', 'MANAGER', 'MEMBER']) })),
      ownOnly: z.boolean(),
      isFinanceMember: z.boolean(),
      isAccountingMember: z.boolean(),
      scopeOrganisationIds: z.array(z.string()),
      joinedAt: z.date(),
    }),
  ),
});

export const ZUnitsCreateTeamsFromHrRequestSchema = z.object({ organisationId: ZOrganisationId });

export const ZUnitsCreateTeamsFromHrResponseSchema = z.object({
  hrAvailable: z.boolean(),
  created: z.array(z.string()),
  setorCount: z.number(),
});

export const ZUnitsCreateTeamRequestSchema = z.object({ organisationId: ZOrganisationId, name: ZTeamName });

export const ZUnitsCreateTeamResponseSchema = z.object({ teamId: z.number() });

export const ZUnitsRenameTeamRequestSchema = z.object({ teamId: z.number().int().positive(), name: ZTeamName });

export const ZUnitsDeleteTeamRequestSchema = z.object({ teamId: z.number().int().positive() });

export const ZUnitsSearchUsersRequestSchema = z.object({
  organisationId: ZOrganisationId,
  query: z.string().max(200),
});

export const ZUnitsSearchUsersResponseSchema = z.object({
  users: z.array(
    z.object({
      id: z.number(),
      name: z.string().nullable(),
      email: z.string(),
      disabled: z.boolean(),
      isMember: z.boolean(),
    }),
  ),
});

export const ZUnitsAddMemberRequestSchema = z.object({
  organisationId: ZOrganisationId,
  userId: z.number().int().positive(),
  teams: ZTeamChoices,
});

export const ZUnitsSetMemberTeamsRequestSchema = ZUnitsAddMemberRequestSchema;

export const ZUnitsRemoveMemberRequestSchema = z.object({
  organisationId: ZOrganisationId,
  userId: z.number().int().positive(),
});

export const ZUnitsSetOwnOnlyRequestSchema = z.object({
  userId: z.number().int().positive(),
  ownOnly: z.boolean(),
});

export const ZUnitsSetScopeRequestSchema = z.object({
  userId: z.number().int().positive(),
  organisationIds: z.array(ZOrganisationId).max(100),
});

export const ZUnitsListProfilesResponseSchema = z.object({
  users: z.array(
    z.object({
      userId: z.number(),
      name: z.string().nullable(),
      email: z.string(),
      disabled: z.boolean(),
      isFinanceMember: z.boolean(),
      isAccountingMember: z.boolean(),
      ownOnly: z.boolean(),
      scopeOrganisationIds: z.array(z.string()),
    }),
  ),
});

export type TUnitsListResponse = z.infer<typeof ZUnitsListResponseSchema>;
export type TUnitsGetResponse = z.infer<typeof ZUnitsGetResponseSchema>;
export type TUnitsListProfilesResponse = z.infer<typeof ZUnitsListProfilesResponseSchema>;
export type TUnitsSearchUsersResponse = z.infer<typeof ZUnitsSearchUsersResponseSchema>;

/** v.26, Task 7: prévia de "Levar as notas antigas para a unidade de quem enviou" (só consulta). */
export const ZUnitsLegacyInvoicesPreviewResponseSchema = z.object({
  moveCount: z.number(),
  movePeopleCount: z.number(),
  stayCount: z.number(),
  stayPeople: z.array(
    z.object({ userId: z.number(), name: z.string().nullable(), email: z.string(), count: z.number() }),
  ),
  stayPeopleCount: z.number(),
});

export const ZUnitsLegacyInvoicesMoveResponseSchema = z.object({
  moved: z.number(),
  failed: z.number(),
  stayed: z.number(),
});
