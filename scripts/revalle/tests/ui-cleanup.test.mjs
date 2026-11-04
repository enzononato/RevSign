// Limpeza da tela (Fase 7, Task 9; spec §6): o que o RevSign não usa sai da tela e o acesso direto (URL ou rota tRPC) é
// recusado. Roda contra a stack local, com uma conta nova (dona do time pessoal, ou seja, ADMIN do time e da
// organização, mas NÃO administradora do sistema) e, nas partes de administrador, a mesma conta promovida por instantes
// a ADMIN pelo banco (o papel volta no `finally`).
//
//   1. rotas: `apiToken.create`, `webhook.createWebhook`/`editWebhook`, `team.settings.update` e
//      `organisation.settings.update` dão 403 ao usuário comum e passam com ADMIN; lembretes e validade do link
//      continuam editáveis pelo usuário comum (mesma rota); token já criado continua valendo e o dono ainda o apaga;
//   2. páginas: as escondidas (inclusive o Suporte) redirecionam, as mantidas respondem 200, tokens e webhooks só abrem para ADMIN;
//   3. `/p/{url}` dá 404 mesmo com perfil público ligado;
//   4. o HTML do painel não tem o link de Modelos; a API de modelos continua;
//   5. num navegador de verdade (imagem do Playwright): menus, busca, lista de configurações, editor e seletor de papel.
//
// Usa REVSIGN_USER_* só para existir (a conta de teste é nova a cada execução). Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import {
  api,
  BASE_URL,
  createEnvelope,
  db,
  fetchIdempotent,
  hasPlaywrightImage,
  PLAYWRIGHT_IMAGE,
  runBrowserScript,
  signIn,
  signupColaborador,
  trpcAs,
} from './helpers.mjs';

const MAILPIT = 'http://localhost:8025/api/v1';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = `Limpeza-${RUN}!`;
const origin = new URL(BASE_URL).origin;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FORBIDDEN_MESSAGE = 'Só o administrador pode alterar isso.';

const fx = {};

// ---------- Conta nova (cadastro, confirmação pelo link do Mailpit e login) ----------

const mailpit = (route) => fetchIdempotent(`${MAILPIT}${route}`, {}, (res) => res.json());

const newAccount = async (label) => {
  const email = `limpeza-${label}-${RUN}@revalle.com.br`;
  const created = await signupColaborador({ name: `Limpeza ${label}`, email, password: PASSWORD });

  assert.ok(created.ok, `cadastro de ${label} falhou (${created.status}): ${await created.text()}`);

  let message;

  for (let i = 0; i < 80 && !message; i += 1) {
    message = ((await mailpit(`/search?query=${encodeURIComponent(`to:${email}`)}`)).messages ?? [])[0];

    if (!message) {
      await sleep(500);
    }
  }

  assert.ok(message, `e-mail de confirmação de ${label} não chegou`);

  const html = (await mailpit(`/message/${message.ID}`)).HTML ?? '';
  const token = html.match(/\/verify-email\/([A-Za-z0-9_-]+)/)?.[1];

  assert.ok(token, `link de confirmação ausente para ${label}`);

  const verified = await fetch(`${BASE_URL}/api/auth/email-password/verify-email`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  assert.equal(verified.status, 200, await verified.text());

  return { email, cookie: await signIn(email, PASSWORD) };
};

// Promove a conta a ADMIN do sistema por instantes e devolve ao papel de usuário comum no fim, mesmo se falhar.
const asAdmin = async (fn) => {
  db(`update "User" set roles = array['USER','ADMIN']::"Role"[] where email = '${fx.user.email}'`);

  try {
    return await fn();
  } finally {
    db(`update "User" set roles = array['USER']::"Role"[] where email = '${fx.user.email}'`);
  }
};

const data = (res) => res.body?.result?.data?.json;
const trpcUser = (kind, procedure, input, extraHeaders = {}) =>
  trpcAs(fx.user.cookie, kind, procedure, input, { 'x-team-id': String(fx.teamId), ...extraHeaders });

const errorOf = (res) => res.body?.error?.json?.message ?? res.text;

const getPage = (route, cookie = fx.user.cookie) =>
  fetchIdempotent(`${BASE_URL}${route}`, { headers: { Cookie: cookie }, redirect: 'manual' }, async (res) => ({
    status: res.status,
    location: res.headers.get('location') ? new URL(res.headers.get('location'), BASE_URL).pathname : null,
    text: await res.text(),
  }));

// O logo da marca tem rota própria (multipart, `payload` em JSON): sem arquivo ele LIMPA o logo, o que o usuário comum não
// pode mais fazer.
const postBrandingLogo = async (procedure, payload) => {
  const form = new FormData();

  form.append('payload', JSON.stringify(payload));

  const res = await fetch(`${BASE_URL}/api/trpc/${procedure}`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: fx.user.cookie, 'x-team-id': String(fx.teamId) },
    body: form,
  });

  return { status: res.status, text: await res.text() };
};

const reminder = { sendAfter: { unit: 'day', amount: 7 }, repeatEvery: { unit: 'day', amount: 3 } };
const reminderOf = (table, id) =>
  JSON.parse(db(`select "reminderSettings" from "${table}" where id = '${id}'`) || 'null');

before(async () => {
  fx.user = await newAccount('comum');

  const row = db(
    `select t.id || '|' || t.url || '|' || o.id || '|' || o.url || '|' || t."teamGlobalSettingsId" || '|' || o."organisationGlobalSettingsId"
       from "Team" t join "Organisation" o on o.id = t."organisationId" join "User" u on u.id = o."ownerUserId"
      where u.email = '${fx.user.email}' limit 1`,
  );

  [fx.teamId, fx.teamUrl, fx.orgId, fx.orgUrl, fx.teamSettingsId, fx.orgSettingsId] = row.split('|');
  fx.teamId = Number(fx.teamId);
  assert.ok(fx.teamUrl && fx.orgUrl, `a conta nova não tem time/organização (${row})`);
});

after(() => {
  if (!fx.user) {
    return;
  }

  db(`update "User" set roles = array['USER']::"Role"[] where email = '${fx.user.email}'`);
  db(`delete from "TeamProfile" where "teamId" = ${fx.teamId}`);
});

// ---------- 1. Rotas ----------

// Foto dos campos que os pedidos recusados tentam mexer (time e organização), para provar que nada foi gravado.
const snapshotSettings = () =>
  db(
    `select concat_ws('|', t."brandingEnabled", t."brandingCompanyDetails", t."includeAuditLog", t."aiFeaturesEnabled", o."brandingEnabled", o."includeAuditLog", o."includeSigningCertificate", o."aiFeaturesEnabled")
       from "TeamGlobalSettings" t, "OrganisationGlobalSettings" o
      where t.id = '${fx.teamSettingsId}' and o.id = '${fx.orgSettingsId}'`,
  );

test('usuário comum: apiToken.create, webhook.createWebhook e as configurações escondidas dão 403 com a mensagem do admin', async () => {
  const untouched = snapshotSettings();

  const token = await trpcUser('mutation', 'apiToken.create', {
    teamId: fx.teamId,
    tokenName: `limpeza-${RUN}`,
    expirationDate: null,
  });

  assert.equal(token.status, 403, token.text);
  assert.equal(errorOf(token), FORBIDDEN_MESSAGE);

  const webhook = await trpcUser('mutation', 'webhook.createWebhook', {
    webhookUrl: 'https://example.com/revsign-limpeza',
    eventTriggers: ['DOCUMENT_COMPLETED'],
    secret: null,
    enabled: true,
  });

  assert.equal(webhook.status, 403, webhook.text);
  assert.equal(errorOf(webhook), FORBIDDEN_MESSAGE);
  assert.equal(db(`select count(*) from "Webhook" where "teamId" = ${fx.teamId}`), '0');

  // Marca, certificado/log de auditoria e IA do Documenso: cada campo da lista é recusado sozinho.
  for (const data of [
    { brandingEnabled: true },
    { brandingCompanyDetails: 'x' },
    { emailReplyTo: 'a@revalle.com.br' },
    { includeAuditLog: false },
    { includeSigningCertificate: false },
    { documentLanguage: 'en' },
    { aiFeaturesEnabled: true },
  ]) {
    const team = await trpcUser('mutation', 'team.settings.update', { teamId: fx.teamId, data });
    const org = await trpcUser('mutation', 'organisation.settings.update', { organisationId: fx.orgId, data });

    assert.equal(team.status, 403, `team.settings.update ${JSON.stringify(data)}: ${team.text}`);
    assert.equal(org.status, 403, `organisation.settings.update ${JSON.stringify(data)}: ${org.text}`);
    assert.equal(errorOf(team), FORBIDDEN_MESSAGE);
    assert.equal(errorOf(org), FORBIDDEN_MESSAGE);
  }

  assert.equal(snapshotSettings(), untouched, 'um pedido recusado mexeu nas configurações');

  const teamLogo = await postBrandingLogo('team.settings.updateBrandingLogo', { teamId: fx.teamId });
  const orgLogo = await postBrandingLogo('organisation.settings.updateBrandingLogo', { organisationId: fx.orgId });

  assert.equal(teamLogo.status, 403, teamLogo.text);
  assert.equal(orgLogo.status, 403, orgLogo.text);
  assert.ok(teamLogo.text.includes(FORBIDDEN_MESSAGE) && orgLogo.text.includes(FORBIDDEN_MESSAGE));
});

test('usuário comum continua editando lembretes e validade do link (mesma rota), mas não esconde um campo proibido junto', async () => {
  const team = await trpcUser('mutation', 'team.settings.update', {
    teamId: fx.teamId,
    data: { reminderSettings: reminder, envelopeExpirationPeriod: { unit: 'day', amount: 9 } },
  });
  const org = await trpcUser('mutation', 'organisation.settings.update', {
    organisationId: fx.orgId,
    data: { reminderSettings: reminder, envelopeExpirationPeriod: { unit: 'day', amount: 9 } },
  });

  assert.equal(team.status, 200, team.text);
  assert.equal(org.status, 200, org.text);
  assert.deepEqual(reminderOf('TeamGlobalSettings', fx.teamSettingsId), reminder);
  assert.deepEqual(reminderOf('OrganisationGlobalSettings', fx.orgSettingsId), reminder);

  // Misturar um campo proibido no mesmo pedido não passa, e o lembrete do pedido misto não é gravado.
  const other = { sendAfter: { unit: 'day', amount: 11 }, repeatEvery: { unit: 'day', amount: 4 } };
  const mixed = await trpcUser('mutation', 'team.settings.update', {
    teamId: fx.teamId,
    data: { reminderSettings: other, brandingEnabled: true },
  });

  assert.equal(mixed.status, 403, mixed.text);
  assert.deepEqual(reminderOf('TeamGlobalSettings', fx.teamSettingsId), reminder);
});

test('ADMIN: as mesmas rotas passam; token criado continua valendo sem ADMIN e o dono ainda o apaga; webhook de ADMIN não é editável por usuário comum', async () => {
  const created = await asAdmin(async () => {
    const token = await trpcUser('mutation', 'apiToken.create', {
      teamId: fx.teamId,
      tokenName: `limpeza-${RUN}`,
      expirationDate: null,
    });

    assert.equal(token.status, 200, token.text);

    const webhook = await trpcUser('mutation', 'webhook.createWebhook', {
      webhookUrl: 'https://example.com/revsign-limpeza',
      eventTriggers: ['DOCUMENT_COMPLETED'],
      secret: null,
      enabled: false,
    });

    assert.equal(webhook.status, 200, webhook.text);

    const edited = await trpcUser('mutation', 'webhook.editWebhook', {
      id: data(webhook).id,
      webhookUrl: 'https://example.com/revsign-limpeza-2',
      eventTriggers: ['DOCUMENT_COMPLETED'],
      secret: null,
      enabled: false,
    });

    assert.equal(edited.status, 200, edited.text);

    // Um valor que o ADMIN muda e que dá para conferir no banco.
    const team = await trpcUser('mutation', 'team.settings.update', {
      teamId: fx.teamId,
      data: { brandingCompanyDetails: `limpeza ${RUN}` },
    });
    const org = await trpcUser('mutation', 'organisation.settings.update', {
      organisationId: fx.orgId,
      data: { brandingCompanyDetails: `limpeza org ${RUN}` },
    });

    assert.equal(team.status, 200, team.text);
    assert.equal(org.status, 200, org.text);
    assert.equal(
      db(`select "brandingCompanyDetails" from "TeamGlobalSettings" where id = '${fx.teamSettingsId}'`),
      `limpeza ${RUN}`,
    );
    assert.equal(
      db(`select "brandingCompanyDetails" from "OrganisationGlobalSettings" where id = '${fx.orgSettingsId}'`),
      `limpeza org ${RUN}`,
    );

    const teamLogo = await postBrandingLogo('team.settings.updateBrandingLogo', { teamId: fx.teamId });
    const orgLogo = await postBrandingLogo('organisation.settings.updateBrandingLogo', { organisationId: fx.orgId });

    assert.equal(teamLogo.status, 200, teamLogo.text);
    assert.equal(orgLogo.status, 200, orgLogo.text);

    return { apiToken: data(token).token, webhookId: data(webhook).id };
  });

  // Já sem ADMIN: o token criado segue funcionando na API (v2 e a rota de modelos, que a tela escondeu mas a API serve).
  const envelopes = await api('GET', '/envelope', undefined, { apiToken: created.apiToken });
  const templates = await api('GET', '/template', undefined, { apiToken: created.apiToken });

  assert.equal(envelopes.status, 200, envelopes.text);
  assert.equal(templates.status, 200, templates.text);

  const edit = await trpcUser('mutation', 'webhook.editWebhook', {
    id: created.webhookId,
    webhookUrl: 'https://example.com/outro',
    eventTriggers: ['DOCUMENT_COMPLETED'],
    secret: null,
    enabled: true,
  });

  assert.equal(edit.status, 403, edit.text);
  assert.equal(
    db(`select "webhookUrl" from "Webhook" where id = '${created.webhookId}'`),
    'https://example.com/revsign-limpeza-2',
  );

  // Apagar continua possível para o dono: o webhook e o próprio token.
  const removedWebhook = await trpcUser('mutation', 'webhook.deleteWebhook', { id: created.webhookId });

  assert.equal(removedWebhook.status, 200, removedWebhook.text);

  const tokens = await trpcUser('query', 'apiToken.getMany', undefined);

  assert.equal(tokens.status, 200, tokens.text);

  const [own] = data(tokens);
  const removedToken = await trpcUser('mutation', 'apiToken.delete', { id: own.id, teamId: fx.teamId });

  assert.equal(removedToken.status, 200, removedToken.text);
  assert.equal((await api('GET', '/envelope', undefined, { apiToken: created.apiToken })).status, 401);
});

// ---------- 2. Páginas ----------

test('usuário comum: páginas escondidas redirecionam e as mantidas abrem', async () => {
  const toDocuments = `/t/${fx.teamUrl}/documents`;
  const toOrgGeneral = `/o/${fx.orgUrl}/settings/general`;

  const hidden = [
    ...['branding', 'email', 'document', 'certificates', 'public-profile', 'tokens', 'webhooks'].map((section) => [
      `/t/${fx.teamUrl}/settings/${section}`,
      toDocuments,
    ]),
    [`/t/${fx.teamUrl}/settings/webhooks/abc`, toDocuments],
    [`/t/${fx.teamUrl}/templates`, toDocuments],
    [`/t/${fx.teamUrl}/templates/folders`, toDocuments],
    [`/t/${fx.teamUrl}/templates/f/qualquer`, toDocuments],
    [`/t/${fx.teamUrl}/templates/1`, toDocuments],
    [`/t/${fx.teamUrl}/templates/1/edit`, toDocuments],
    [`/t/${fx.teamUrl}/templates/1/legacy_editor`, toDocuments],
    ...['branding', 'email', 'document', 'certificates'].map((section) => [
      `/o/${fx.orgUrl}/settings/${section}`,
      toOrgGeneral,
    ]),
    // O Suporte saiu do menu da conta; o endereço direto também não abre mais.
    [`/o/${fx.orgUrl}/support`, toOrgGeneral],
  ];

  for (const [route, destination] of hidden) {
    const res = await getPage(route);

    assert.equal(res.status, 302, `${route} deveria redirecionar (HTTP ${res.status})`);
    assert.equal(res.location, destination, `${route} redireciona para o lugar errado`);
  }

  const kept = [
    `/t/${fx.teamUrl}/settings/general`,
    `/t/${fx.teamUrl}/settings/members`,
    `/t/${fx.teamUrl}/settings/groups`,
    `/t/${fx.teamUrl}/settings/reminders`,
    `/o/${fx.orgUrl}/settings/general`,
    `/o/${fx.orgUrl}/settings/teams`,
    `/o/${fx.orgUrl}/settings/members`,
    `/o/${fx.orgUrl}/settings/groups`,
    `/o/${fx.orgUrl}/settings/reminders`,
  ];

  for (const route of kept) {
    const res = await getPage(route);

    assert.equal(res.status, 200, `${route} deveria abrir (HTTP ${res.status}, ${res.location ?? ''})`);
  }
});

test('quem não entrou continua caindo no login nas páginas escondidas (a ordem dos guardas não mudou)', async () => {
  for (const route of [
    `/t/${fx.teamUrl}/settings/branding`,
    `/t/${fx.teamUrl}/settings/tokens`,
    `/t/${fx.teamUrl}/templates`,
    `/o/${fx.orgUrl}/settings/email`,
    `/o/${fx.orgUrl}/support`,
  ]) {
    const res = await fetchIdempotent(`${BASE_URL}${route}`, { redirect: 'manual' }, async (r) => ({
      status: r.status,
      location: r.headers.get('location'),
    }));

    assert.equal(res.status, 302, route);
    assert.match(res.location ?? '', /\/signin$/, route);
  }
});

test('ADMIN: tokens e webhooks abrem; marca, e-mail, documento, certificado, perfil público e modelos seguem fechados', async () => {
  await asAdmin(async () => {
    for (const route of [
      `/t/${fx.teamUrl}/settings/tokens`,
      `/t/${fx.teamUrl}/settings/webhooks`,
      `/t/${fx.teamUrl}/settings/general`,
    ]) {
      const res = await getPage(route);

      assert.equal(res.status, 200, `${route}: HTTP ${res.status} ${res.location ?? ''}`);
    }

    for (const route of [
      ...['branding', 'email', 'document', 'certificates', 'public-profile'].map(
        (section) => `/t/${fx.teamUrl}/settings/${section}`,
      ),
      `/t/${fx.teamUrl}/templates`,
      `/t/${fx.teamUrl}/templates/1/edit`,
      ...['branding', 'email', 'document', 'certificates'].map((section) => `/o/${fx.orgUrl}/settings/${section}`),
      `/o/${fx.orgUrl}/support`,
    ]) {
      const res = await getPage(route);

      assert.equal(res.status, 302, `${route} deveria continuar fechado para o ADMIN (HTTP ${res.status})`);
    }
  });
});

// ---------- 3 e 4. Perfil público, menu e API ----------

test('/p/{url} dá 404 mesmo com o perfil público ligado no banco', async () => {
  const id = randomUUID().replaceAll('-', '').slice(0, 25);

  db(`insert into "TeamProfile" (id, enabled, "teamId", bio) values ('${id}', true, ${fx.teamId}, 'perfil de teste')`);

  try {
    const res = await getPage(`/p/${fx.teamUrl}`);

    assert.equal(res.status, 404, `/p/${fx.teamUrl} (HTTP ${res.status})`);
    assert.ok(!res.text.includes('perfil de teste'), 'a biografia do perfil apareceu');
  } finally {
    db(`delete from "TeamProfile" where id = '${id}'`);
  }

  assert.equal((await getPage('/p/qualquer-coisa')).status, 404);
});

test('o painel não mostra o link de Modelos (menu), mas mostra o que ficou', async () => {
  const res = await getPage(`/t/${fx.teamUrl}/documents`);

  assert.equal(res.status, 200, `HTTP ${res.status}`);

  const html = res.text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

  assert.ok(html.includes(`href="/t/${fx.teamUrl}/documents"`), 'o menu perdeu o link de documentos');
  assert.ok(html.includes('href="/notas-fiscais"'), 'o menu perdeu o link de notas fiscais');
  assert.ok(!html.includes(`/t/${fx.teamUrl}/templates`), 'o painel ainda aponta para os modelos');
  assert.ok(!/>\s*(Templates|Modelos)\s*</.test(html), 'o painel ainda tem o texto Templates/Modelos');
});

// ---------- 5. Navegador ----------

test('navegador: menus, busca, configurações, editor e seletor de papel sem IA, Modelos, Assistente, Idioma e Suporte', async (t) => {
  if (!hasPlaywrightImage()) {
    t.skip(`imagem ${PLAYWRIGHT_IMAGE} ausente no Docker (docker pull ${PLAYWRIGHT_IMAGE})`);

    return;
  }

  // Rascunho com um PDF e dois destinatários, criado com um token do próprio usuário (criado por instantes como ADMIN).
  const draft = await asAdmin(async () => {
    const token = await trpcUser('mutation', 'apiToken.create', {
      teamId: fx.teamId,
      tokenName: `limpeza-navegador-${RUN}`,
      expirationDate: null,
    });

    assert.equal(token.status, 200, token.text);

    const created = await createEnvelope({
      apiToken: data(token).token,
      recipients: [{ email: `limpeza-dest-${RUN}@revalle.com.br` }],
    });

    assert.equal(created.status, 200, created.text);

    return created;
  });

  const payload = {
    baseUrl: BASE_URL,
    teamUrl: fx.teamUrl,
    orgUrl: fx.orgUrl,
    cookie: fx.user.cookie,
    draftId: draft.id,
  };

  const runBrowser = async (extra) => {
    const result = await runBrowserScript({
      script: 'ui-cleanup.browser.mjs',
      payload: { ...payload, ...extra },
      shotDir: process.env.REVSIGN_UI_CLEANUP_SHOTS,
    });

    t.diagnostic(result.stdout);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  };

  await runBrowser({ phase: 'main' });

  // Com o papel de ADMIN (devolvido no fim, mesmo se falhar): vê Tokens de API e Webhooks no menu e abre as duas páginas.
  await asAdmin(async () => runBrowser({ phase: 'admin' }));
});
