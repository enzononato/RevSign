// Task 9 (Fase 3): sugestões pelos vínculos, status de vínculo e tela de admin.
// Precisa de uma sessão comum (REVSIGN_USER_EMAIL / REVSIGN_USER_PASSWORD, dono do token de API) e,
// para as rotas de admin, do admin da stack (REVSIGN_ADMIN_EMAIL / REVSIGN_ADMIN_PASSWORD, igual a NEXT_PRIVATE_REVALLE_ADMIN_EMAIL).
import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';

import { createEnvelope, db, distribute, signIn, trpc, trpcAs } from './helpers.mjs';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };
const sessionOpts = (creds) => (creds.email && creds.password ? {} : { skip: 'credenciais de sessão não informadas' });

let userCookie;
let adminCookie;

const unique = () => `adm-${Date.now()}-${Math.floor(Math.random() * 1e6)}@revalle.com.br`;
const data = (res) => res.body?.result?.data?.json;

const newRecipient = async (email = unique()) => {
  const created = await createEnvelope({ recipients: [{ email }] });

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);

  return { email, token: recipient.token, envelopeId: created.id, recipientId: recipient.id };
};

const gate = (procedure, input) => trpc(`revalle.gate.${procedure}`, input);

const link = async () => {
  const r = await newRecipient();

  await gate('acceptTerm', { token: r.token, termVersion: '1' });
  await gate('verifyIdentity', { token: r.token, cpf: MARIA.cpf, birthDate: MARIA.birthDate });
  await gate('confirmIdentity', { token: r.token, isMe: true });

  return r;
};

const lock = async () => {
  const r = await newRecipient();

  await gate('acceptTerm', { token: r.token, termVersion: '1' });

  for (let i = 0; i < 5; i += 1) {
    await gate('verifyIdentity', { token: r.token, cpf: MARIA.cpf, birthDate: '01/01/2001' });
  }

  return r;
};

before(async () => {
  if (user.email && user.password) {
    userCookie = await signIn(user.email, user.password);
  }

  if (admin.email && admin.password) {
    adminCookie = await signIn(admin.email, admin.password);
  }
});

beforeEach(() => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
});

test('sugestões: depois do vínculo, o e-mail aparece pelo nome e pelo e-mail, sem CPF', sessionOpts(user), async () => {
  const r = await link();

  for (const query of ['maria teste', 'MÁRIA', r.email.slice(0, 12)]) {
    const res = await trpcAs(userCookie, 'query', 'recipient.suggestions.find', { query });

    assert.equal(res.status, 200, res.text);

    const found = data(res).results.filter((item) => item.email === r.email);

    assert.equal(found.length, 1, `query "${query}": ${res.text}`);
    assert.ok(data(res).results.length <= 8);
    assert.ok(!res.text.includes(MARIA.cpf));
  }

  const byName = data(await trpcAs(userCookie, 'query', 'recipient.suggestions.find', { query: 'maria teste' }));

  assert.equal(byName.results.find((item) => item.email === r.email).name, 'Maria Teste da Silva');
});

test('recipientLinkStatus: vinculado e base = true, novo = false; exige sessão', sessionOpts(user), async () => {
  const r = await link();
  const fresh = unique();
  const input = { emails: [r.email.toUpperCase(), fresh, 'joao.teste@revalle.com.br'] };

  const res = await trpcAs(userCookie, 'query', 'revalle.recipientLinkStatus', input);

  assert.equal(res.status, 200, res.text);
  assert.deepEqual(data(res), [
    { email: r.email.toUpperCase(), isLinked: true },
    { email: fresh, isLinked: false },
    { email: 'joao.teste@revalle.com.br', isLinked: false },
  ]);

  const anonymous = await trpc('revalle.recipientLinkStatus', input);

  assert.notEqual(anonymous.status, 200);
});

test('admin: usuário comum não consegue usar as rotas de admin', sessionOpts(user), async () => {
  const r = await lock();
  const gateId = db(`select id from "RevalleRecipientGate" where "recipientId" = ${r.recipientId}`);

  const unlock = await trpcAs(userCookie, 'mutation', 'revalle.admin.unlockGate', { gateId });
  const find = await trpcAs(userCookie, 'query', 'revalle.admin.findGates', { type: 'LOCKED' });
  const del = await trpcAs(userCookie, 'mutation', 'revalle.admin.deleteLink', { linkId: 'x' });

  for (const res of [unlock, find, del]) {
    assert.ok(res.status === 401 || res.status === 403, res.text);
  }

  assert.notEqual(db(`select "lockedAt" from "RevalleRecipientGate" where id = '${gateId}'`), '');
});

test(
  'admin: lista bloqueados e desbloqueia (estado sai de LOCKED, auditoria com e-mail do admin)',
  sessionOpts(admin),
  async () => {
    const r = await lock();
    const gateId = db(`select id from "RevalleRecipientGate" where "recipientId" = ${r.recipientId}`);

    assert.equal(
      (await gate('acceptTerm', { token: r.token, termVersion: '1' })).body.result.data.json.status,
      'LOCKED',
    );

    const list = data(await trpcAs(adminCookie, 'query', 'revalle.admin.findGates', { type: 'LOCKED' }));
    const item = list.locked.find((entry) => entry.id === gateId);

    assert.ok(item, 'link bloqueado não listado');
    assert.equal(item.recipientEmail, r.email);
    assert.equal(item.reason, 'ATTEMPTS');

    const unlocked = await trpcAs(adminCookie, 'mutation', 'revalle.admin.unlockGate', { gateId });

    assert.equal(unlocked.status, 200, unlocked.text);
    assert.equal(
      db(
        `select "failedAttempts" || '|' || coalesce("lockedAt"::text,'') || '|' || coalesce("lockReason",'') || '|' || "identityStatus" || '|' || coalesce("pendingCpf",'') || '|' || ("termAcceptedAt" is not null) from "RevalleRecipientGate" where id = '${gateId}'`,
      ),
      '0|||PENDING||true',
    );

    const state = (await gate('verifyIdentity', { token: r.token, cpf: MARIA.cpf, birthDate: MARIA.birthDate })).body
      .result.data.json;

    assert.equal(state.status, 'IDENTITY_CONFIRM');
    assert.equal(
      db(
        `select data::text from "DocumentAuditLog" where "envelopeId" = '${r.envelopeId}' and type = 'REVALLE_GATE_UNLOCKED'`,
      ).includes(admin.email),
      true,
    );

    const again = await trpcAs(adminCookie, 'mutation', 'revalle.admin.unlockGate', { gateId });

    assert.equal(again.status, 404);
  },
);

test('admin: lista vínculos com CPF mascarado e busca; remove o vínculo', sessionOpts(admin), async () => {
  const r = await link();

  const res = await trpcAs(adminCookie, 'query', 'revalle.admin.findGates', {
    type: 'LINKS',
    search: r.email.toUpperCase(),
  });
  const [item] = data(res).links;

  assert.equal(data(res).links.length, 1);
  assert.equal(item.email, r.email);
  assert.equal(item.name, 'Maria Teste da Silva');
  assert.equal(item.cpfMasked, '***.533.447-**');
  assert.ok(!res.text.includes(MARIA.cpf));

  const removed = await trpcAs(adminCookie, 'mutation', 'revalle.admin.deleteLink', { linkId: item.id });

  assert.equal(removed.status, 200, removed.text);
  assert.equal(db(`select count(*) from "RevalleEmailLink" where email = '${r.email}'`), '0');

  const status = data(
    await trpcAs(userCookie ?? adminCookie, 'query', 'revalle.recipientLinkStatus', { emails: [r.email] }),
  );

  assert.equal(status[0].isLinked, false);
});
