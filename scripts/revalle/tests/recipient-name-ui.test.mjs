// Destinatário só com e-mail (17/11/2026), lado do editor:
// - rota `revalle.recipients.accountName` (dica "Conta: {nome}"): nome da conta do e-mail, `null` sem conta ou com conta
//   sem nome; só para quem é do time;
// - o editor manda o nome vazio: para o mesmo e-mail o nome gravado fica (pode ser o do RH); com o e-mail trocado, vale o
//   da conta nova;
// - no navegador: sem o campo Nome, "Conta: {nome}" para o e-mail de uma conta; salvar e enviar só com o e-mail.
// Sem a imagem do Playwright, o caso do navegador é pulado. Sessão: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN). Prints
// em REVSIGN_F9_SHOTS (pasta já criada), quando definido.
import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';

import { ensureTestAccount } from './account-helpers.mjs';
import {
  BASE_URL,
  createEnvelope,
  db,
  hasPlaywrightImage,
  PLAYWRIGHT_IMAGE,
  runBrowserScript,
  signIn,
  trpcAs,
} from './helpers.mjs';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const gmail = (tag) => `rnui-${tag}-${RUN}@gmail.com`;
const company = (tag) => `rnui-${tag}-${RUN}@revalle.com.br`;
const SHOT_DIR = process.env.REVSIGN_F9_SHOTS;

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
let userCookie;

const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
const teamOf = (envelopeId) => db(`select "teamId" from "Envelope" where id = '${envelopeId}'`);
const nameOf = (recipientId) => db(`select name from "Recipient" where id = ${recipientId}`);
const data = (res) => res.body?.result?.data?.json;

const account = (email, name) => {
  ensureTestAccount(email, name ?? 'x');
  db(`update "User" set name = ${name === null ? 'null' : sql(name)} where email = ${sql(email)}`);

  return email;
};

const accountName = (email, teamId) =>
  trpcAs(userCookie, 'query', 'revalle.recipients.accountName', { email }, teamId ? { 'x-team-id': teamId } : {});

const setRecipients = (envelopeId, recipients) =>
  trpcAs(
    userCookie,
    'mutation',
    'envelope.recipient.set',
    { envelopeId, envelopeType: 'DOCUMENT', recipients },
    { 'x-team-id': teamOf(envelopeId) },
  );

const sessionTest = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie) {
      t.skip('credenciais de sessão não informadas (REVSIGN_USER_*)');

      return;
    }

    await fn(t);
  });

before(async () => {
  if (user.email && user.password) {
    userCookie = await signIn(user.email, user.password);
  }
});

beforeEach(() => {
  db(`delete from "RateLimit" where action = 'revalle.recipient-account-name'`);
});

sessionTest('rota accountName: nome da conta, null sem conta ou conta sem nome, só para quem é do time', async () => {
  const draft = await createEnvelope({ recipients: [{ email: gmail('rota') }] });

  assert.equal(draft.status, 200, draft.text);

  const teamId = teamOf(draft.id);
  const email = account(company('rota'), 'Diana Conta Rota');
  const semNome = account(company('rota-sem-nome'), null);

  const found = await accountName(email.toUpperCase(), teamId);

  assert.equal(found.status, 200, found.text);
  assert.deepEqual(data(found), { name: 'Diana Conta Rota' });
  assert.deepEqual(data(await accountName(gmail('sem-conta'), teamId)), { name: null });
  assert.deepEqual(data(await accountName(semNome, teamId)), { name: null });
  assert.deepEqual(data(await accountName('incompleto@', teamId)), { name: null });

  // Sem o time (ou com um time de que a pessoa não faz parte): recusado, sem nome.
  const noTeam = await accountName(email);

  assert.notEqual(noTeam.status, 200, noTeam.text);
  assert.ok(!noTeam.text.includes('Diana Conta Rota'));

  const otherTeam = db(
    `select t.id from "Team" t where not exists (select 1 from "TeamGroup" tg join "OrganisationGroupMember" ogm on ogm."groupId" = tg."organisationGroupId" join "OrganisationMember" om on om.id = ogm."organisationMemberId" join "User" u on u.id = om."userId" where tg."teamId" = t.id and u.email = ${sql(user.email)}) order by t.id limit 1`,
  );

  if (otherTeam) {
    const foreign = await accountName(email, otherTeam);

    assert.notEqual(foreign.status, 200, foreign.text);
    assert.ok(!foreign.text.includes('Diana Conta Rota'));
  }
});

sessionTest(
  'editor: nome vazio para o mesmo e-mail não apaga o nome gravado; e-mail novo pega o da conta',
  async () => {
    const draft = await createEnvelope({ recipients: [{ email: gmail('mantem'), name: 'Maria Teste da Silva' }] });

    assert.equal(draft.status, 200, draft.text);

    const recipientId = draft.envelope.recipients[0].id;
    const same = await setRecipients(draft.id, [{ id: recipientId, email: gmail('mantem'), name: '', role: 'SIGNER' }]);

    assert.equal(same.ok, true, same.text);
    assert.equal(nameOf(recipientId), 'Maria Teste da Silva');

    const email = account(company('mantem-nova'), 'Elisa Conta Nova');
    const changed = await setRecipients(draft.id, [{ id: recipientId, email, name: '', role: 'SIGNER' }]);

    assert.equal(changed.ok, true, changed.text);
    assert.equal(nameOf(recipientId), 'Elisa Conta Nova');
  },
);

sessionTest('navegador: sem o campo Nome, "Conta: {nome}" e envio só com o e-mail', async (t) => {
  if (!hasPlaywrightImage()) {
    t.skip(`imagem ${PLAYWRIGHT_IMAGE} ausente no Docker (docker pull ${PLAYWRIGHT_IMAGE})`);

    return;
  }

  const draft = await createEnvelope({ recipients: [{ email: gmail('tela-antes') }] });

  assert.equal(draft.status, 200, draft.text);

  const teamId = teamOf(draft.id);
  const teamUrl = db(`select url from "Team" where id = ${Number(teamId)}`);
  const recipientId = draft.envelope.recipients[0].id;
  const email = account(company('tela'), 'Fabiana Conta Tela');

  const browser = await runBrowserScript({
    script: 'recipient-name-ui.browser.mjs',
    payload: {
      baseUrl: BASE_URL,
      ownerCookie: userCookie,
      teamUrl,
      draftId: draft.id,
      accountEmail: email,
      accountName: 'Fabiana Conta Tela',
      noAccountEmail: gmail('tela-sem-conta'),
    },
    shotDir: SHOT_DIR,
    timeout: 240_000,
  });

  t.diagnostic(browser.stdout);
  assert.equal(browser.status, 0, `${browser.stdout}\n${browser.stderr}`);

  // O editor gravou só o e-mail; o nome é o da conta (o nome antigo, de outro e-mail, não ficou).
  assert.equal(db(`select email from "Recipient" where id = ${recipientId}`), email);
  assert.equal(nameOf(recipientId), 'Fabiana Conta Tela');

  // Envio como a tela faz, só com o e-mail.
  const sent = await trpcAs(
    userCookie,
    'mutation',
    'envelope.distribute',
    { envelopeId: draft.id },
    {
      'x-team-id': teamId,
    },
  );

  assert.equal(sent.ok, true, sent.text);
  assert.equal(db(`select status from "Envelope" where id = '${draft.id}'`), 'PENDING');
});
