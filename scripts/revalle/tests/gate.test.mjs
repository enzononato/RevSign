// Núcleo do portão de assinatura (Task 5, Fase 3): termo, identidade, bloqueio e avisos.
// Pessoas fictícias da base de desenvolvimento: revalle/colaboradores/dev-seed.sql.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { beforeEach, test } from 'node:test';

import { createEnvelope, db, distribute, latestMail, trpc } from './helpers.mjs';

const TERM_VERSION = '1';
const ADMIN_EMAIL = 'teste1@revalle.com.br';
const MARIA = { cpf: '390.533.447-05', cpfDigits: '39053344705', birthDate: '07/03/1990' };
const JOAO = { cpf: '52871936455', birthDate: '20/11/1985' };
const ANA = { cpf: '74612058380', birthDate: '15/01/1978' };

const COMPOSE = ['compose', '-f', 'revalle/deploy/compose.hml.yml', '--env-file', '../local-hml/hml.env'];
const compose = (...args) => execFileSync('docker', [...COMPOSE, ...args], { stdio: 'ignore' });

const unique = () => `gate-${Date.now()}-${Math.floor(Math.random() * 1e6)}@revalle.com.br`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const newRecipient = async (email = unique()) => {
  const created = await createEnvelope({ recipients: [{ email }] });

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);

  return { email, token: recipient.token, envelopeId: created.id, recipientId: recipient.id };
};

const call = async (procedure, input) => {
  const res = await trpc(`revalle.gate.${procedure}`, input);

  return { ...res, state: res.body?.result?.data?.json };
};

const acceptTerm = (token) => call('acceptTerm', { token, termVersion: TERM_VERSION });
const verify = (token, cpf, birthDate) => call('verifyIdentity', { token, cpf, birthDate });
const attempts = (recipientId) =>
  Number(db(`select "failedAttempts" from "RevalleRecipientGate" where "recipientId" = ${recipientId}`));

beforeEach(() => {
  db(`delete from "RateLimit" where action = 'revalle.gate'`);
  db(`delete from "RevalleEmailLink" where cpf in ('${MARIA.cpfDigits}', '${JOAO.cpf}', '${ANA.cpf}')`);
});

test('term-first: verificar identidade antes do termo devolve TERM_REQUIRED', async () => {
  const r = await newRecipient();
  const res = await verify(r.token, MARIA.cpf, MARIA.birthDate);

  assert.equal(res.status, 200, res.text);
  assert.equal(res.state.status, 'TERM_REQUIRED');
  assert.equal(res.state.termVersion, TERM_VERSION);
  assert.match(res.state.termText, /MP 2\.200-2/);
  assert.equal(attempts(r.recipientId), 0);
});

test('token desconhecido é NOT_FOUND', async () => {
  const res = await acceptTerm('token-que-nao-existe');

  assert.equal(res.status, 404, res.text);
});

test('versão do termo diferente da vigente é recusada', async () => {
  const r = await newRecipient();
  const res = await call('acceptTerm', { token: r.token, termVersion: '0' });

  assert.equal(res.ok, false);
});

test('happy-path: termo, CPF + data, confirmação e vínculo criado', async () => {
  const r = await newRecipient();

  assert.equal((await acceptTerm(r.token)).state.status, 'IDENTITY_REQUIRED');

  const verified = await verify(r.token, MARIA.cpf, MARIA.birthDate);

  assert.equal(verified.state.status, 'IDENTITY_CONFIRM');
  assert.equal(verified.state.preview.primeiroNome, 'Maria');

  const confirmed = await call('confirmIdentity', { token: r.token, isMe: true });

  assert.equal(confirmed.state.status, 'PASSED');
  assert.equal(db(`select cpf from "RevalleEmailLink" where email = '${r.email}'`), MARIA.cpfDigits);
});

test('confirmar "não sou eu" volta para PENDING sem consumir tentativa', async () => {
  const r = await newRecipient();

  await acceptTerm(r.token);
  await verify(r.token, MARIA.cpf, MARIA.birthDate);

  const res = await call('confirmIdentity', { token: r.token, isMe: false });

  assert.equal(res.state.status, 'IDENTITY_REQUIRED');
  assert.equal(res.state.attemptsLeft, 5);
  assert.equal(attempts(r.recipientId), 0);
});

test('linked-skips: segundo envelope para o mesmo e-mail passa direto depois do termo', async () => {
  const first = await newRecipient();

  await acceptTerm(first.token);
  await verify(first.token, MARIA.cpf, MARIA.birthDate);
  await call('confirmIdentity', { token: first.token, isMe: true });

  const second = await newRecipient(first.email);
  const res = await acceptTerm(second.token);

  assert.equal(res.state.status, 'PASSED');
  assert.equal(
    db(`select "identityStatus" from "RevalleRecipientGate" where "recipientId" = ${second.recipientId}`),
    'LINKED',
  );
});

test('base-email-skips: e-mail que está na base passa depois do termo', async () => {
  const r = await newRecipient('com.email@revalle.com.br');
  const res = await acceptTerm(r.token);

  assert.equal(res.state.status, 'PASSED');
  assert.equal(db(`select cpf from "RevalleRecipientGate" where "recipientId" = ${r.recipientId}`), JOAO.cpf);
});

test('same-error: CPF fora da base e data errada têm a mesma resposta e consomem tentativa', async () => {
  const a = await newRecipient();
  const b = await newRecipient();
  const c = await newRecipient();
  const d = await newRecipient();

  for (const r of [a, b, c, d]) {
    await acceptTerm(r.token);
  }

  const notInBase = await verify(a.token, '11144477735', MARIA.birthDate);
  const wrongDate = await verify(b.token, MARIA.cpf, '08/03/1990');
  const badDigits = await verify(c.token, '12345678900', MARIA.birthDate);
  const badDate = await verify(d.token, MARIA.cpf, '31/02/1990');

  for (const res of [notInBase, wrongDate, badDigits, badDate]) {
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.state, { status: 'IDENTITY_REQUIRED', attemptsLeft: 4 });
    assert.equal(res.text, notInBase.text);
  }

  for (const r of [a, b, c, d]) {
    assert.equal(attempts(r.recipientId), 1);
  }
});

test('lockout: 5 falhas bloqueiam, avisam dono e admin e persistem', async () => {
  const r = await newRecipient();

  await acceptTerm(r.token);

  let last;

  for (let i = 0; i < 5; i += 1) {
    last = await verify(r.token, MARIA.cpf, '01/01/2001');
  }

  assert.equal(last.state.status, 'LOCKED');
  assert.equal(attempts(r.recipientId), 5);
  assert.equal(
    db(`select "lockReason" from "RevalleRecipientGate" where "recipientId" = ${r.recipientId}`),
    'ATTEMPTS',
  );
  assert.equal((await verify(r.token, MARIA.cpf, MARIA.birthDate)).state.status, 'LOCKED');
  assert.equal((await acceptTerm(r.token)).state.status, 'LOCKED');

  await sleep(1500);

  for (const to of ['admin@hml.local', ADMIN_EMAIL]) {
    const mail = await latestMail(to);

    assert.ok(mail, `sem e-mail para ${to}`);
    assert.match(mail.Subject, /Link de assinatura bloqueado/);
    assert.ok(mail.HTML.includes(r.email));
    assert.ok(!mail.HTML.includes(MARIA.cpfDigits) && !mail.Text.includes(MARIA.cpfDigits));
  }
});

test('cpf-conflict: CPF de colaborador com outro e-mail na base bloqueia', async () => {
  const r = await newRecipient();

  await acceptTerm(r.token);

  const res = await verify(r.token, JOAO.cpf, JOAO.birthDate);

  assert.equal(res.state.status, 'LOCKED');
  assert.equal(
    db(`select "lockReason" from "RevalleRecipientGate" where "recipientId" = ${r.recipientId}`),
    'CPF_CONFLICT',
  );
  assert.equal(
    db(
      `select count(*) from "DocumentAuditLog" where "envelopeId" = '${r.envelopeId}' and type = 'REVALLE_GATE_LOCKED'`,
    ),
    '1',
  );
});

test('cpf-conflict: CPF já vinculado a outro e-mail pelo vínculo bloqueia', async () => {
  const first = await newRecipient();

  await acceptTerm(first.token);
  await verify(first.token, MARIA.cpf, MARIA.birthDate);
  await call('confirmIdentity', { token: first.token, isMe: true });

  const other = await newRecipient();

  await acceptTerm(other.token);

  assert.equal((await verify(other.token, MARIA.cpf, MARIA.birthDate)).state.status, 'LOCKED');
});

test('desligado: situação não bloqueia', async () => {
  const r = await newRecipient();

  await acceptTerm(r.token);

  const verified = await verify(r.token, ANA.cpf, ANA.birthDate);

  assert.equal(verified.state.status, 'IDENTITY_CONFIRM');
  assert.equal(verified.state.preview.primeiroNome, 'Ana');
  assert.equal((await call('confirmIdentity', { token: r.token, isMe: true })).state.status, 'PASSED');
});

test('tentativas em paralelo não passam de 5', async () => {
  const r = await newRecipient();

  await acceptTerm(r.token);
  await Promise.all(Array.from({ length: 12 }, () => verify(r.token, MARIA.cpf, '01/01/2001')));

  assert.equal((await verify(r.token, MARIA.cpf, MARIA.birthDate)).state.status, 'LOCKED');
  assert.ok(attempts(r.recipientId) <= 12);
  assert.equal(
    db(
      `select count(*) from "DocumentAuditLog" where "envelopeId" = '${r.envelopeId}' and type = 'REVALLE_GATE_LOCKED'`,
    ),
    '1',
  );
  assert.equal(
    db(
      `select count(*) from "DocumentAuditLog" where "envelopeId" = '${r.envelopeId}' and type = 'REVALLE_IDENTITY_FAILED'`,
    ),
    '5',
  );
});

test('base-down: base fora do ar devolve UNAVAILABLE sem consumir tentativa', async (t) => {
  const r = await newRecipient();

  await acceptTerm(r.token);
  compose('stop', 'colaboradores-db');
  t.after(() => compose('start', 'colaboradores-db'));

  const res = await verify(r.token, MARIA.cpf, MARIA.birthDate);

  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.state, { status: 'UNAVAILABLE' });
  assert.equal(attempts(r.recipientId), 0);
});

test('audit: eventos REVALLE_* têm IP e nenhum dado traz CPF completo nem data de nascimento', async () => {
  const r = await newRecipient();

  await acceptTerm(r.token);
  await verify(r.token, MARIA.cpf, '01/01/2001');
  await verify(r.token, MARIA.cpf, MARIA.birthDate);
  await call('confirmIdentity', { token: r.token, isMe: true });

  const rows = db(
    `select type || '|' || coalesce("ipAddress", '') || '|' || data::text from "DocumentAuditLog" where "envelopeId" = '${r.envelopeId}' and type like 'REVALLE_%' order by "createdAt"`,
  ).split('\n');
  const types = rows.map((row) => row.split('|')[0]);

  assert.deepEqual(types, ['REVALLE_TERM_ACCEPTED', 'REVALLE_IDENTITY_FAILED', 'REVALLE_IDENTITY_CONFIRMED']);

  for (const row of rows) {
    assert.ok(row.split('|')[1], `sem IP: ${row}`);
    assert.ok(!row.includes(MARIA.cpfDigits), row);
    assert.ok(!row.includes(MARIA.cpf), row);
    assert.ok(!/1990|07\/03|01\/01\/2001|2001-01-01/.test(row.split('|').slice(2).join('|')), row);
  }

  assert.match(rows[2], /\*\*\*\.447\.05|\*\*\*\.533\.447-\*\*/);
});

test('o estado não grava a data de nascimento digitada', async () => {
  const r = await newRecipient();

  await acceptTerm(r.token);
  await verify(r.token, MARIA.cpf, MARIA.birthDate);

  const row = db(`select to_json(g)::text from "RevalleRecipientGate" g where "recipientId" = ${r.recipientId}`);

  assert.ok(!/1990|07\/03/.test(row), row);
});
