import { prisma } from '@documenso/prisma';
import { RevalleInvoiceStatus } from '@prisma/client';

import { AppError } from '../../../errors/app-error';
import { isCollaboratorContractTeamUrl } from '../../../revalle/collaborator-contract-team';
import { buildTeamWhereQuery } from '../../../utils/teams';

/** Texto exato da recusa (e do aviso do diálogo de envio). */
export const INVOICE_UNIT_TEAM_REQUIRED_MESSAGE =
  'Nota fiscal deve ser enviada pelo time da sua unidade. Troque para o time no topo da tela.';

/**
 * REVALLE (v.26): os times de unidade da pessoa (organização marcada em `RevalleUnit`), em ordem de id. O primeiro é
 * o time padrão do envio quando não há último time aberto. O time "Contratos para colaboradores" nunca entra.
 */
export const findRevalleUnitTeams = async (userId: number): Promise<{ id: number; url: string }[]> => {
  const teams = await prisma.team.findMany({
    where: {
      ...buildTeamWhereQuery({ teamId: undefined, userId }),
      organisation: { revalleUnit: { isNot: null } },
    },
    orderBy: { id: 'asc' },
    select: { id: true, url: true },
  });

  return teams.filter((team) => !isCollaboratorContractTeamUrl(team.url));
};

export const findFirstRevalleUnitTeamUrl = async (userId: number): Promise<string | null> =>
  (await findRevalleUnitTeams(userId))[0]?.url ?? null;

/** O time é de uma organização marcada como unidade? */
export const isRevalleUnitTeam = async (teamId: number): Promise<boolean> => {
  const unit = await prisma.revalleUnit.findFirst({
    where: { organisation: { teams: { some: { id: teamId } } } },
    select: { organisationId: true },
  });

  return unit !== null;
};

/**
 * Nota fiscal só sai de um time de unidade (v.26). Chamado no primeiro envio, depois de a classificação dizer que o
 * envio é nota fiscal (`YES`). "Apenas assinar" (não é NF) nunca chega aqui. A nova versão de uma NF já enviada (troca
 * de conta pelo Financeiro, `previousEnvelopeId`) não é recusada: ela fica no time da original, e as notas antigas do
 * espaço pessoal precisam continuar sendo corrigidas.
 */
export const assertInvoiceFromUnitTeam = async ({ envelopeId, teamId }: { envelopeId: string; teamId: number }) => {
  const row = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { isInvoice: true, previousEnvelopeId: true },
  });

  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES || row.previousEnvelopeId) {
    return;
  }

  if (await isRevalleUnitTeam(teamId)) {
    return;
  }

  throw new AppError('INVOICE_UNIT_TEAM_REQUIRED', {
    message: INVOICE_UNIT_TEAM_REQUIRED_MESSAGE,
    userMessage: INVOICE_UNIT_TEAM_REQUIRED_MESSAGE,
    statusCode: 400,
  });
};
