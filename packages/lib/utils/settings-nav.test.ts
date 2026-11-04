import { OrganisationMemberRole, TeamMemberRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { getSettingsNavGroups } from './settings-nav';

// REVALLE (Fase 7, Task 9): o menu de configurações só mostra o que o RevSign usa. Confere por caminho (o que a pessoa
// abre), não por chave, para pegar a página escondida mesmo que alguém renomeie a chave.
const buildNav = (isAdmin: boolean) =>
  getSettingsNavGroups({
    organisation: {
      url: 'acme',
      currentOrganisationRole: OrganisationMemberRole.ADMIN,
      organisationClaim: { flags: {} },
    },
    team: { url: 'setor', currentTeamRole: TeamMemberRole.ADMIN },
    hasManageableBillingOrgs: false,
    isAdmin,
  });

const sectionsOf = (group: { items: { path: string }[] } | null) =>
  (group?.items ?? []).map((item) => item.path.split('/settings/')[1]);

const HIDDEN_FOR_EVERYONE = ['branding', 'email', 'document', 'certificates', 'public-profile'];

describe('getSettingsNavGroups (limpeza da tela)', () => {
  it('usuário comum não vê marca, e-mail, documento, certificado, perfil público, tokens nem webhooks', () => {
    const { organisation, team } = buildNav(false);

    for (const section of [...HIDDEN_FOR_EVERYONE, 'tokens', 'webhooks']) {
      expect(sectionsOf(team)).not.toContain(section);
      expect(sectionsOf(organisation)).not.toContain(section);
    }
  });

  it('o que o Enzo mantém para organizar por setor continua no menu', () => {
    const { organisation, team } = buildNav(false);

    expect(sectionsOf(team)).toEqual(expect.arrayContaining(['general', 'members', 'groups', 'reminders']));
    expect(sectionsOf(organisation)).toEqual(
      expect.arrayContaining(['general', 'teams', 'members', 'groups', 'reminders']),
    );
  });

  it('o admin ganha tokens e webhooks do time e continua sem as páginas escondidas para todos', () => {
    const { organisation, team } = buildNav(true);

    expect(sectionsOf(team)).toEqual(expect.arrayContaining(['tokens', 'webhooks']));

    for (const section of HIDDEN_FOR_EVERYONE) {
      expect(sectionsOf(team)).not.toContain(section);
      expect(sectionsOf(organisation)).not.toContain(section);
    }
  });

  it('sem sub-menu "Preferências": cada item que sobrou é um link direto', () => {
    const { organisation, team } = buildNav(true);

    for (const item of [...(organisation?.items ?? []), ...(team?.items ?? [])]) {
      expect(item.isSubNav).toBeUndefined();
      expect(item.isSubNavParent).toBeUndefined();
    }
  });
});
