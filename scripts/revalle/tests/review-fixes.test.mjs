// Correções da revisão final da Fase 3: troca de token ao mudar o e-mail, getDocumentByToken com portão,
// conflito de CPF com CPF mascarado na auditoria e e-mail do vínculo no admin, recipientLinkStatus só para e-mails da empresa.
// Sessões: REVSIGN_USER_EMAIL/PASSWORD (dono do token de API) e REVSIGN_ADMIN_EMAIL/PASSWORD (papel ADMIN, e-mail da empresa).
import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';

import { api, BASE_URL, createEnvelope, db, distribute, signIn, trpc, trpcAs } from './helpers.mjs';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const BEATRIZ = { cpf: '68340192787', birthDate: '09/09/1988' };
const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };
const sessionOpts = (creds) => (creds.email && creds.password ? {} : { skip: 'credenciais de sessão não informadas' });

const unique = (tag) => `review-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@revalle.com.br`;
const data = (res) => res.body?.result?.data?.json;
const gate = (procedure, input) => trpc(`revalle.gate.${procedure}`, input);

let userCookie;
let adminCookie;

const newRecipient = async (email = unique('r')) => {
  const created = await createEnvelope({ recipients: [{ email }] });

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);

  return { ...recipient, envelopeId: created.id, envelope: created.envelope };
};

const passGate = async (token, person = MARIA) => {
  await gate('acceptTerm', { token, termVersion: '1' });
  assert.equal(
    data(await gate('verifyIdentity', { token, cpf: person.cpf, birthDate: person.birthDate })).status,
    'IDENTITY_CONFIRM',
  );
  assert.equal(data(await gate('confirmIdentity', { token, isMe: true })).status, 'PASSED');
};

const assertOldTokenDead = async (oldToken) => {
  assert.equal(db(`select count(*) from "Recipient" where token = '${oldToken}'`), '0');
  assert.equal((await fetch(`${BASE_URL}/sign/${oldToken}`)).status, 404);
  assert.equal((await gate('acceptTerm', { token: oldToken, termVersion: '1' })).status, 404);
  assert.equal((await trpc('document.accessAuth.request2FAEmail', { token: oldToken })).status, 404);
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
  db(`delete from "RevalleEmailLink" where cpf in ('${MARIA.cpf}', '${BEATRIZ.cpf}')`);
});

test('trocar o e-mail pela API (update-many) troca o token: o link antigo dá 404', async () => {
  const r = await newRecipient();
  const newEmail = unique('novo');

  const res = await api('POST', '/envelope/recipient/update-many', {
    envelopeId: r.envelopeId,
    data: [{ id: r.id, email: newEmail }],
  });

  assert.equal(res.status, 200, res.text);

  const newToken = db(`select token from "Recipient" where id = ${r.id}`);

  assert.notEqual(newToken, r.token);
  await assertOldTokenDead(r.token);
  assert.equal((await gate('acceptTerm', { token: newToken, termVersion: '1' })).status, 200);
  assert.equal((await fetch(`${BASE_URL}/sign/${newToken}`)).status, 200);

  // Mudar só a caixa do e-mail não troca o token.
  const same = await api('POST', '/envelope/recipient/update-many', {
    envelopeId: r.envelopeId,
    data: [{ id: r.id, email: newEmail.toUpperCase() }],
  });

  assert.equal(same.status, 200, same.text);
  assert.equal(db(`select token from "Recipient" where id = ${r.id}`), newToken);
});

test('trocar o e-mail no editor (envelope.recipient.set) troca o token', sessionOpts(user), async () => {
  const r = await newRecipient();
  const newEmail = unique('editor');
  const teamId = (await api('GET', `/envelope/${r.envelopeId}`)).body.teamId;

  const res = await trpcAs(
    userCookie,
    'mutation',
    'envelope.recipient.set',
    {
      envelopeId: r.envelopeId,
      envelopeType: 'DOCUMENT',
      recipients: [{ id: r.id, email: newEmail, name: 'Teste', role: 'SIGNER' }],
    },
    { 'x-team-id': String(teamId) },
  );

  assert.equal(res.status, 200, res.text);
  assert.notEqual(db(`select token from "Recipient" where id = ${r.id}`), r.token);
  await assertOldTokenDead(r.token);
});

test('document.getDocumentByToken só depois do portão', sessionOpts(admin), async () => {
  db(`delete from "RevalleEmailLink" where email = '${admin.email}'`);

  const r = await newRecipient(admin.email);
  const blocked = await trpcAs(adminCookie, 'query', 'document.getDocumentByToken', { token: r.token });

  assert.notEqual(blocked.status, 200, blocked.text);
  assert.match(blocked.text, /Conclua a verificação/);

  await passGate(r.token);

  const after = await trpcAs(adminCookie, 'query', 'document.getDocumentByToken', { token: r.token });

  assert.equal(after.status, 200, after.text);
  db(`delete from "RevalleEmailLink" where email = '${admin.email}'`);
});

test('conflito de CPF: auditoria com CPF mascarado; admin mostra o e-mail do vínculo atual', async () => {
  const a = await newRecipient();
  const b = await newRecipient();

  for (const r of [a, b]) {
    await gate('acceptTerm', { token: r.token, termVersion: '1' });
    assert.equal(
      data(await gate('verifyIdentity', { token: r.token, cpf: BEATRIZ.cpf, birthDate: BEATRIZ.birthDate })).status,
      'IDENTITY_CONFIRM',
    );
  }

  assert.equal(data(await gate('confirmIdentity', { token: b.token, isMe: true })).status, 'PASSED');
  assert.equal(data(await gate('confirmIdentity', { token: a.token, isMe: true })).status, 'LOCKED');

  const audit = db(
    `select data::text from "DocumentAuditLog" where "envelopeId" = '${a.envelopeId}' and type = 'REVALLE_GATE_LOCKED'`,
  );

  assert.match(audit, /CPF_CONFLICT/);
  assert.match(audit, /\*\*\*\.401\.927-\*\*/);
  assert.ok(!audit.includes(BEATRIZ.cpf));

  if (adminCookie) {
    const gateId = db(`select id from "RevalleRecipientGate" where "recipientId" = ${a.id}`);
    const list = data(await trpcAs(adminCookie, 'query', 'revalle.admin.findGates', { type: 'LOCKED' }));
    const item = list.locked.find((entry) => entry.id === gateId);

    assert.equal(item?.reason, 'CPF_CONFLICT');
    assert.equal(item?.conflictEmail, b.email);
    assert.ok(!JSON.stringify(list).includes(BEATRIZ.cpf));

    assert.equal((await trpcAs(adminCookie, 'mutation', 'revalle.admin.unlockGate', { gateId })).status, 200);
    assert.equal(db(`select coalesce("conflictCpf", '') from "RevalleRecipientGate" where id = '${gateId}'`), '');
  }
});

test(
  'recipientLinkStatus: e-mail fora da empresa é "não vinculado" sem consulta; máximo 20 e-mails',
  sessionOpts(user),
  async () => {
    const outside = `fora-${Date.now()}@gmail.com`;

    db(`insert into "RevalleEmailLink" (id, email, cpf) values ('t-out-${Date.now()}', '${outside}', '${MARIA.cpf}')`);

    const res = await trpcAs(userCookie, 'query', 'revalle.recipientLinkStatus', { emails: [outside] });

    assert.equal(res.status, 200, res.text);
    assert.deepEqual(data(res), [{ email: outside, isLinked: false }]);

    const tooMany = Array.from({ length: 21 }, (_, i) => `muitos${i}@revalle.com.br`);
    const limited = await trpcAs(userCookie, 'query', 'revalle.recipientLinkStatus', { emails: tooMany });

    assert.equal(limited.status, 400, limited.text);

    db(`delete from "RevalleEmailLink" where email = '${outside}'`);
  },
);
