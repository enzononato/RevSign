// v.20: o item "Documentos" do menu lateral aparece sempre para quem tem time (ver
// docs/superpowers/specs/2026-11-17-menu-documentos-design.md). Fora de uma página de time, o link vai ao último time
// aberto (cookie `revalle_last_team`, gravado ao abrir qualquer página de time), senão ao primeiro time que não é o
// pessoal, senão ao pessoal. Conta sem organização ganha a pessoal ao carregar a sessão (uma vez só, mesmo com pedidos
// ao mesmo tempo), menos conta desativada.
//
// Contas novas pelo cadastro de verdade (`createConfirmedAccount`); o segundo time nasce pelo app (`team.create`, a conta
// é ADMIN da própria organização pessoal). O HTML do servidor é conferido aqui (o menu sai certo sem piscar); o
// navegador (`browser/menu-documents.browser.mjs`) confere a navegação pelo menu. Sem a imagem do Playwright, só a parte
// do navegador é pulada. Prints em REVSIGN_MENU_SHOTS (pasta já criada), quando definido.

import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import {
  BASE_URL,
  createConfirmedAccount,
  db,
  fetchIdempotent,
  hasPlaywrightImage,
  PLAYWRIGHT_IMAGE,
  runBrowserScript,
  trpcAs,
} from './helpers.mjs';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = `Menu-${RUN}-Senha1`;
const SHOT_DIR = process.env.REVSIGN_MENU_SHOTS;
const LAST_TEAM_COOKIE = 'revalle_last_team';

const emailOf = (tag) => `menu-${tag}-${RUN}@revalle.com.br`;

const personalOrgOf = (userId) =>
  db(
    `select o.id from "Organisation" o join "OrganisationMember" m on m."organisationId" = o.id where m."userId" = ${Number(userId)} and o.type = 'PERSONAL' order by o."createdAt" limit 1`,
  );

const firstTeamOf = (orgId) =>
  db(`select url from "Team" where "organisationId" = '${orgId.replaceAll("'", "''")}' order by id limit 1`);

const membershipsOf = (userId) =>
  Number(db(`select count(*) from "OrganisationMember" where "userId" = ${Number(userId)}`));

const ownedPersonalOrgsOf = (userId) =>
  Number(db(`select count(*) from "Organisation" where "ownerUserId" = ${Number(userId)} and type = 'PERSONAL'`));

// Sessão da organização como o menu carrega (o mesmo caminho que cria a pessoal quando falta).
const loadSession = (cookie) => trpcAs(cookie, 'query', 'organisation.internal.getOrganisationSession', undefined);

const organisationsOf = (res) => res.body?.result?.data?.json ?? [];

// HTML da página como o servidor manda (sem JavaScript). `extraCookie` soma um cookie ao da sessão.
const serverHtml = (pathname, cookie, extraCookie = '') =>
  fetchIdempotent(
    `${BASE_URL}${pathname}`,
    { headers: { Cookie: extraCookie ? `${cookie}; ${extraCookie}` : cookie } },
    (res) => res.text(),
  );

const documentsHrefs = (html) => [...html.matchAll(/href="(\/t\/[^"/]+\/documents)"/g)].map((match) => match[1]);

let twoTeams;
let oneTeam;
// Conta recuperada (sem organização até a sessão carregar), para o navegador.
let healed = null;

before(async () => {
  const account = await createConfirmedAccount({ email: emailOf('dois'), name: 'Teste Menu Dois', password: PASSWORD });
  const orgId = personalOrgOf(account.id);

  assert.ok(orgId, 'a conta nova não tem organização pessoal');

  const personalTeamUrl = firstTeamOf(orgId);
  const otherTeamUrl = `menu-${RUN}`;
  const created = await trpcAs(account.cookie, 'mutation', 'team.create', {
    organisationId: orgId,
    teamName: 'Time do Menu',
    teamUrl: otherTeamUrl,
    inheritMembers: true,
  });

  assert.equal(created.status, 200, created.text);

  twoTeams = { ...account, personalTeamUrl, otherTeamUrl };

  const single = await createConfirmedAccount({ email: emailOf('um'), name: 'Teste Menu Um', password: PASSWORD });

  oneTeam = { ...single, personalTeamUrl: firstTeamOf(personalOrgOf(single.id)) };
});

test('dois times, fora de time: o servidor já manda Documentos para o time que não é o pessoal', async () => {
  const html = await serverHtml('/notas-fiscais', twoTeams.cookie);

  assert.ok(documentsHrefs(html).includes(`/t/${twoTeams.otherTeamUrl}/documents`), documentsHrefs(html).join(', '));
});

test('a página de time grava o cookie do último time (1 ano, todo o site)', async () => {
  const res = await fetch(`${BASE_URL}/t/${twoTeams.personalTeamUrl}/documents`, {
    headers: { Cookie: twoTeams.cookie },
    redirect: 'manual',
  });

  await res.arrayBuffer();

  const setCookie = res.headers.getSetCookie().find((line) => line.startsWith(`${LAST_TEAM_COOKIE}=`));

  assert.equal(res.status, 200);
  assert.ok(setCookie, 'sem o cookie do último time');
  assert.match(setCookie, new RegExp(`^${LAST_TEAM_COOKIE}=${twoTeams.personalTeamUrl};`));
  assert.match(setCookie, /Max-Age=31536000/);
  assert.match(setCookie, /Path=\//);
});

test('com o cookie do último time, o servidor manda Documentos para ele; time que não é da pessoa é ignorado', async () => {
  const withLast = await serverHtml(
    '/notas-fiscais',
    twoTeams.cookie,
    `${LAST_TEAM_COOKIE}=${twoTeams.personalTeamUrl}`,
  );

  assert.ok(
    documentsHrefs(withLast).includes(`/t/${twoTeams.personalTeamUrl}/documents`),
    documentsHrefs(withLast).join(', '),
  );

  // O último time de outra conta não vira link: volta ao primeiro que não é o pessoal.
  const foreign = await serverHtml('/notas-fiscais', twoTeams.cookie, `${LAST_TEAM_COOKIE}=${oneTeam.personalTeamUrl}`);

  assert.ok(!documentsHrefs(foreign).includes(`/t/${oneTeam.personalTeamUrl}/documents`), 'link para time alheio');
  assert.ok(
    documentsHrefs(foreign).includes(`/t/${twoTeams.otherTeamUrl}/documents`),
    documentsHrefs(foreign).join(', '),
  );
});

test('um time só: Documentos vai a ele, como antes', async () => {
  const html = await serverHtml('/inbox', oneTeam.cookie);

  assert.ok(documentsHrefs(html).includes(`/t/${oneTeam.personalTeamUrl}/documents`), documentsHrefs(html).join(', '));
});

test('conta sem organização ganha a pessoal ao carregar a sessão, uma vez só', async () => {
  const account = await createConfirmedAccount({ email: emailOf('zero'), name: 'Teste Menu Zero', password: PASSWORD });

  db(`delete from "OrganisationMember" where "userId" = ${account.id}`);
  assert.equal(membershipsOf(account.id), 0);

  const ownedBefore = ownedPersonalOrgsOf(account.id);

  // Vários pedidos ao mesmo tempo: a trava por conta deixa só um criar.
  const sessions = await Promise.all(Array.from({ length: 5 }, () => loadSession(account.cookie)));

  for (const res of sessions) {
    assert.equal(res.status, 200, res.text);
    assert.equal(organisationsOf(res).length, 1, res.text);
  }

  assert.equal(membershipsOf(account.id), 1);
  assert.equal(ownedPersonalOrgsOf(account.id), ownedBefore + 1);

  const [organisation] = organisationsOf(sessions[0]);

  assert.equal(organisation.type, 'PERSONAL');
  assert.equal(organisation.teams.length, 1);

  const html = await serverHtml('/notas-fiscais', account.cookie);

  assert.ok(
    documentsHrefs(html).includes(`/t/${organisation.teams[0].url}/documents`),
    documentsHrefs(html).join(', '),
  );

  // A tela também: ao entrar, o menu mostra Documentos (navegador abaixo, quando houver a imagem).
  healed = { cookie: account.cookie, teamUrl: organisation.teams[0].url };
});

test('conta desativada sem organização não ganha a pessoal', async () => {
  const account = await createConfirmedAccount({ email: emailOf('off'), name: 'Teste Menu Off', password: PASSWORD });

  db(`delete from "OrganisationMember" where "userId" = ${account.id}`);
  db(`update "User" set disabled = true where id = ${account.id}`);

  try {
    await loadSession(account.cookie);
    await serverHtml('/notas-fiscais', account.cookie);

    assert.equal(membershipsOf(account.id), 0);
  } finally {
    db(`update "User" set disabled = false where id = ${account.id}`);
  }
});

test('navegador: Documentos pelo menu, com dois times, com um time e na conta recuperada', async (t) => {
  if (!hasPlaywrightImage()) {
    t.skip(`imagem ${PLAYWRIGHT_IMAGE} ausente no Docker (docker pull ${PLAYWRIGHT_IMAGE})`);

    return;
  }

  const browser = await runBrowserScript({
    script: 'menu-documents.browser.mjs',
    payload: {
      baseUrl: BASE_URL,
      twoTeams: {
        cookie: twoTeams.cookie,
        personalTeamUrl: twoTeams.personalTeamUrl,
        otherTeamUrl: twoTeams.otherTeamUrl,
      },
      oneTeam: { cookie: oneTeam.cookie, teamUrl: oneTeam.personalTeamUrl },
      healed,
    },
    shotDir: SHOT_DIR,
    timeout: 240_000,
  });

  t.diagnostic(browser.stdout);
  assert.equal(browser.status, 0, `${browser.stdout}\n${browser.stderr}`);
});
