// Destinatário só com e-mail (17/11/2026): o nome vem da conta ao gravar e da base do RH no portão.
// - Ao gravar (API v2, editor por tRPC, troca de e-mail): nome vazio + e-mail de conta com nome → nome da conta. Nome que
//   já existe nunca muda; conta sem nome (ou em branco) deixa o nome vazio, nunca "null".
// - Sem conta: o nome fica vazio e o convite sai sem saudação quebrada ("Olá ,"); a mensagem com {signer.name} usa o e-mail.
// - Portão: depois do CPF (ou do vínculo / e-mail na base), Recipient.name é o nome do RH, com o evento
//   REVALLE_RECIPIENT_NAME_FROM_HR (nome antigo e novo, sem CPF); nome já igual ou portão de novo não gera evento; base
//   fora do ar não troca nada.
// Pessoas fictícias de revalle/colaboradores/dev-seed.sql. Sessão: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, beforeEach, test } from 'node:test';

import './account-autologin.mjs'; // conta obrigatória (16/11/2026): entra na conta de quem assina pelo e-mail da empresa
import { ensureTestAccount } from './account-helpers.mjs';
import { api, createEnvelope, db, distribute, mailIdsTo, signIn, trpc, trpcAs, waitNewMail } from './helpers.mjs';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const gmail = (tag) => `rn-${tag}-${RUN}@gmail.com`;
const company = (tag) => `rn-${tag}-${RUN}@revalle.com.br`;

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990', nome: 'Maria Teste da Silva' };
const JOAO = { cpf: '52871936455', baseEmail: 'com.email@revalle.com.br', nome: 'João Exemplo Pereira' };
const FERNANDO_CPF = '93457210888';

const COMPOSE = ['compose', '-f', 'revalle/deploy/compose.hml.yml', '--env-file', '../local-hml/hml.env'];
const compose = (...args) => execFileSync('docker', [...COMPOSE, ...args], { stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForBase = async () => {
  compose('start', 'colaboradores-db');

  for (let i = 0; i < 40; i += 1) {
    try {
      execFileSync('docker', ['exec', 'revsign-hml-colaboradores-db-1', 'pg_isready', '-q'], { stdio: 'ignore' });

      return;
    } catch {
      await sleep(500);
    }
  }

  throw new Error('colaboradores-db não ficou pronto a tempo');
};

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
let userCookie;

const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
const nameOf = (recipientId) => db(`select name from "Recipient" where id = ${recipientId}`);
const recipientIdOf = (envelopeId, email) =>
  Number(db(`select id from "Recipient" where "envelopeId" = '${envelopeId}' and email = ${sql(email)}`));
const teamOf = (envelopeId) => db(`select "teamId" from "Envelope" where id = '${envelopeId}'`);
const nameEvents = (envelopeId) =>
  JSON.parse(
    db(
      `select coalesce(json_agg(data order by "createdAt", id), '[]') from "DocumentAuditLog" where "envelopeId" = '${envelopeId}' and type = 'REVALLE_RECIPIENT_NAME_FROM_HR'`,
    ),
  );

// Conta com nome conhecido (inserida direto no banco; `name` null ou em branco para os casos de conta sem nome).
const account = (email, name) => {
  ensureTestAccount(email, name ?? 'x');
  db(`update "User" set name = ${name === null ? 'null' : sql(name)} where email = ${sql(email)}`);

  return email;
};

const gate = async (procedure, input) => {
  const res = await trpc(`revalle.gate.${procedure}`, input);

  return { ...res, state: res.body?.result?.data?.json };
};
const acceptTerm = (token) => gate('acceptTerm', { token, termVersion: '1' });
const verify = (token, person) => gate('verifyIdentity', { token, cpf: person.cpf, birthDate: person.birthDate });
const confirm = (token) => gate('confirmIdentity', { token, isMe: true });

// Documento enviado pela API v2 a um destinatário com o nome informado; devolve o destinatário com o token.
const sentTo = async (email, name = '') => {
  const created = await createEnvelope({ recipients: [{ email, name }] });

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);

  return { ...recipient, recipientId: recipient.id, envelopeId: created.id };
};

const sessionTest = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie) {
      t.skip('credenciais de sessão não informadas (REVSIGN_USER_*)');

      return;
    }

    await fn(t);
  });

const cleanupLinks = () => db(`delete from "RevalleEmailLink" where email like 'rn-%-${RUN}@%'`);

before(async () => {
  if (user.email && user.password) {
    userCookie = await signIn(user.email, user.password);
  }
});

beforeEach(() => {
  db('delete from "RateLimit"');
});

after(() => {
  cleanupLinks();
});

// ---- Ao gravar: nome da conta ----

test('API v2: criar sem nome com o e-mail de uma conta grava o nome da conta (e-mail em maiúsculas também)', async () => {
  const email = account(company('conta-api'), 'Ana Conta Revalle');
  const created = await createEnvelope({ recipients: [{ email: email.toUpperCase(), name: '' }] });

  assert.equal(created.status, 200, created.text);
  assert.equal(created.envelope.recipients[0].name, 'Ana Conta Revalle');
  assert.equal(nameOf(created.envelope.recipients[0].id), 'Ana Conta Revalle');

  // O evento de destinatário criado já leva o nome.
  const other = account(company('conta-api-2'), 'Bruno Conta Revalle');
  const added = await api('POST', '/envelope/recipient/create-many', {
    envelopeId: created.id,
    data: [{ email: other, name: '', role: 'SIGNER' }],
  });

  assert.equal(added.status, 200, added.text);
  assert.equal(added.body.data[0].name, 'Bruno Conta Revalle');
  assert.equal(
    db(
      `select data->>'recipientName' from "DocumentAuditLog" where "envelopeId" = '${created.id}' and type = 'RECIPIENT_CREATED' and data->>'recipientEmail' = ${sql(other)}`,
    ),
    'Bruno Conta Revalle',
  );
});

test('API v2: nome informado nunca é trocado pelo da conta', async () => {
  const email = account(company('conta-nome'), 'Nome da Conta');
  const created = await createEnvelope({ recipients: [{ email, name: 'Nome Informado' }] });

  assert.equal(created.status, 200, created.text);
  assert.equal(nameOf(created.envelope.recipients[0].id), 'Nome Informado');
});

test('conta sem nome ou com nome em branco: o nome fica vazio, nunca "null"', async () => {
  const semNome = account(company('conta-null'), null);
  const branco = account(company('conta-branco'), '   ');
  const created = await createEnvelope({
    recipients: [
      { email: semNome, name: '' },
      { email: branco, name: '' },
    ],
  });

  assert.equal(created.status, 200, created.text);

  for (const recipient of created.envelope.recipients) {
    assert.equal(nameOf(recipient.id), '');
  }
});

test('sem conta: o nome fica vazio', async () => {
  const created = await createEnvelope({ recipients: [{ email: gmail('sem-conta'), name: '' }] });

  assert.equal(created.status, 200, created.text);
  assert.equal(nameOf(created.envelope.recipients[0].id), '');
});

test('trocar o e-mail para o de outra conta: nome existente fica; nome vazio pega o da conta nova', async () => {
  const a = account(company('troca-a'), 'Conta A');
  const b = account(company('troca-b'), 'Conta B');
  const c = account(company('troca-c'), 'Conta C');
  const created = await createEnvelope({ recipients: [{ email: a, name: '' }, { email: gmail('troca-d') }] });

  assert.equal(created.status, 200, created.text);

  const first = recipientIdOf(created.id, a);
  const second = recipientIdOf(created.id, gmail('troca-d'));

  assert.equal(nameOf(first), 'Conta A');

  // Só o e-mail muda: o nome que veio da conta A fica (nunca é trocado no servidor).
  const kept = await api('POST', '/envelope/recipient/update-many', {
    envelopeId: created.id,
    data: [{ id: first, email: b }],
  });

  assert.equal(kept.status, 200, kept.text);
  assert.equal(nameOf(first), 'Conta A');

  // E-mail e nome vazio juntos (como o editor manda depois de trocar o e-mail): o nome é o da conta nova.
  const filled = await api('POST', '/envelope/recipient/update-many', {
    envelopeId: created.id,
    data: [{ id: second, email: c, name: '' }],
  });

  assert.equal(filled.status, 200, filled.text);
  assert.equal(nameOf(second), 'Conta C');
});

sessionTest(
  'editor (tRPC envelope.recipient.set): sem nome, com o e-mail de uma conta, grava o nome da conta',
  async () => {
    const email = account(company('conta-tela'), 'Carla Conta Tela');
    const draft = await createEnvelope({ recipients: [{ email: gmail('tela-antes') }] });

    assert.equal(draft.status, 200, draft.text);

    const recipientId = draft.envelope.recipients[0].id;
    const set = await trpcAs(
      userCookie,
      'mutation',
      'envelope.recipient.set',
      {
        envelopeId: draft.id,
        envelopeType: 'DOCUMENT',
        recipients: [{ id: recipientId, email, name: '', role: 'SIGNER' }],
      },
      { 'x-team-id': teamOf(draft.id) },
    );

    assert.equal(set.ok, true, set.text);
    assert.equal(nameOf(recipientId), 'Carla Conta Tela');
    assert.ok(set.text.includes('Carla Conta Tela'), 'a resposta do editor já traz o nome');
  },
);

// ---- Sem nome: convite sem saudação quebrada ----

test('sem conta: o convite sai sem "Olá ," e {signer.name} vira o e-mail', async () => {
  const email = gmail('convite');
  const seen = await mailIdsTo(email);
  const created = await createEnvelope({
    recipients: [{ email, name: '' }],
    meta: { distributionMethod: 'EMAIL', message: 'Olá {signer.name}, segue o documento para assinar.' },
  });

  assert.equal(created.status, 200, created.text);
  await distribute(created.id);

  const mail = await waitNewMail(email, seen, { what: 'Convite para assinar' });

  for (const body of [mail.Text ?? '', mail.HTML ?? '']) {
    assert.doesNotMatch(body, /Olá\s+,/);
    assert.doesNotMatch(body, /Olá,\s*[,.]/);
  }

  assert.ok((mail.Text ?? '').includes(`Olá ${email}, segue o documento para assinar.`), mail.Text);
});

// ---- Portão: nome do RH ----

test('portão (e-mail de fora): sem nome, depois do CPF o nome é o do RH, com o evento sem CPF; portão de novo não repete', async () => {
  const r = await sentTo(gmail('portao'), '');

  await acceptTerm(r.token);
  assert.equal((await verify(r.token, MARIA)).state.status, 'IDENTITY_CONFIRM');
  assert.equal((await confirm(r.token)).state.status, 'PASSED');

  assert.equal(nameOf(r.recipientId), MARIA.nome);
  assert.deepEqual(nameEvents(r.envelopeId), [{ recipientId: r.recipientId, from: null, to: MARIA.nome }]);

  const log = db(
    `select data::text || coalesce(name, '') || coalesce(email, '') from "DocumentAuditLog" where "envelopeId" = '${r.envelopeId}' and type = 'REVALLE_RECIPIENT_NAME_FROM_HR'`,
  );

  assert.ok(!log.includes(MARIA.cpf) && !log.includes('390.533'), 'o evento não leva o CPF');
  assert.ok(!log.includes('1990'), 'o evento não leva a data de nascimento');

  // Portão de novo (outra confirmação, outro carregamento da página): nada muda e nenhum evento novo.
  await confirm(r.token);
  await acceptTerm(r.token);
  assert.equal(nameEvents(r.envelopeId).length, 1);
});

test('portão: nome informado por quem enviou é trocado pelo do RH, com o nome antigo no evento', async () => {
  const r = await sentTo(gmail('portao-troca'), 'Apelido da Maria');

  await acceptTerm(r.token);
  await verify(r.token, MARIA);
  assert.equal((await confirm(r.token)).state.status, 'PASSED');

  assert.equal(nameOf(r.recipientId), MARIA.nome);
  assert.deepEqual(nameEvents(r.envelopeId), [
    { recipientId: r.recipientId, from: 'Apelido da Maria', to: MARIA.nome },
  ]);
});

test('portão: nome já igual ao do RH não gera evento', async () => {
  const r = await sentTo(gmail('portao-igual'), MARIA.nome);

  await acceptTerm(r.token);
  await verify(r.token, MARIA);
  assert.equal((await confirm(r.token)).state.status, 'PASSED');

  assert.equal(nameOf(r.recipientId), MARIA.nome);
  assert.deepEqual(nameEvents(r.envelopeId), []);
});

test('portão (e-mail da empresa na base): passa sem CPF e o nome passa a ser o do RH', async () => {
  const r = await sentTo(JOAO.baseEmail, '');

  assert.equal((await acceptTerm(r.token)).state.status, 'PASSED');
  assert.equal(nameOf(r.recipientId), JOAO.nome);

  const events = nameEvents(r.envelopeId);

  assert.equal(events.length, 1);
  assert.equal(events[0].to, JOAO.nome);
});

test('portão com a base fora do ar (vínculo salvo): o nome fica como estava e não há evento', async (t) => {
  const email = company('base-fora');

  db(`insert into "RevalleEmailLink" (id, email, cpf) values ('rn-${RUN}', ${sql(email)}, '${FERNANDO_CPF}')`);

  const r = await sentTo(email, 'Nome Antes');

  compose('stop', 'colaboradores-db');
  t.after(waitForBase);

  assert.equal((await acceptTerm(r.token)).state.status, 'PASSED');
  assert.equal(
    db(`select "identityStatus" from "RevalleRecipientGate" where "recipientId" = ${r.recipientId}`),
    'LINKED',
  );
  assert.equal(nameOf(r.recipientId), 'Nome Antes');
  assert.deepEqual(nameEvents(r.envelopeId), []);
});
