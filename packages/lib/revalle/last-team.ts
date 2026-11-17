import { OrganisationType } from '@prisma/client';

// Último time aberto, para o link "Documentos" do menu fora das páginas de time. Cookie de primeira parte só com o `url`
// do time (sem dado pessoal), legível no navegador para o menu acompanhar a navegação sem recarregar a página.
export const REVALLE_LAST_TEAM_COOKIE = 'revalle_last_team';

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;
const MAX_TEAM_URL_LENGTH = 64;

/** O `url` do último time no header Cookie (ou `document.cookie`); null quando não há ou é inválido. */
export const readLastTeamCookie = (cookieHeader: string | null | undefined): string | null => {
  for (const part of (cookieHeader ?? '').split(';')) {
    const index = part.indexOf('=');

    if (index === -1 || part.slice(0, index).trim() !== REVALLE_LAST_TEAM_COOKIE) {
      continue;
    }

    try {
      const value = decodeURIComponent(part.slice(index + 1).trim());

      return value.length > 0 && value.length <= MAX_TEAM_URL_LENGTH ? value : null;
    } catch {
      return null;
    }
  }

  return null;
};

/** Header Set-Cookie do último time (1 ano, todo o site). */
export const serializeLastTeamCookie = (teamUrl: string, { secure }: { secure: boolean }) =>
  [
    `${REVALLE_LAST_TEAM_COOKIE}=${encodeURIComponent(teamUrl)}`,
    'Path=/',
    `Max-Age=${ONE_YEAR_IN_SECONDS}`,
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');

type MenuOrganisation = {
  type: OrganisationType;
  teams: { id: number; url: string }[];
};

/**
 * Time do link "Documentos": o time da página; senão o último aberto, se ainda é da pessoa; senão o primeiro que não é o
 * pessoal; por último o pessoal. "Pessoal" é o primeiro time criado da organização pessoal. Sem time nenhum, null.
 */
export const pickDocumentsTeamUrl = ({
  organisations,
  currentTeamUrl,
  lastTeamUrl,
}: {
  organisations: MenuOrganisation[];
  currentTeamUrl?: string | null;
  lastTeamUrl?: string | null;
}): string | null => {
  if (currentTeamUrl) {
    return currentTeamUrl;
  }

  const teams = organisations
    .flatMap((organisation) => {
      const sorted = [...organisation.teams].sort((a, b) => a.id - b.id);

      return sorted.map((team, index) => ({
        id: team.id,
        url: team.url,
        isPersonal: organisation.type === OrganisationType.PERSONAL && index === 0,
      }));
    })
    .sort((a, b) => a.id - b.id);

  if (lastTeamUrl && teams.some((team) => team.url === lastTeamUrl)) {
    return lastTeamUrl;
  }

  return (teams.find((team) => !team.isPersonal) ?? teams[0])?.url ?? null;
};
