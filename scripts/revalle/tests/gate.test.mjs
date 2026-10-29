// Núcleo do portão de assinatura (Task 5, Fase 3): termo, identidade, bloqueio e avisos.
// Pessoas fictícias da base de desenvolvimento: revalle/colaboradores/dev-seed.sql.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { beforeEach, test } from 'node:test';

import { api, createEnvelope, db, distribute, latestMail, trpc } from './helpers.mjs';

const TERM_VERSION = '1';
const ADMIN_EMAIL = 'teste1@revalle.com.br';
const MARIA = { cpf: '390.533.447-05', cpfDigits: '39053344705', birthDate: '07/03/1990' };
const JOAO = { cpf: '52871936455', birthDate: '20/11/1985' };
const ANA = { cpf: '74612058380', birthDate: '15/01/1978' };
const BEATRIZ = { cpf: '68340192787', birthDate: '09/09/1988' };
const FERNANDO = { cpf: '93457210888', birthDate: '31/12/1999' };
const ALL_CPFS = [MARIA.cpfDigits, JOAO.cpf, ANA.cpf, BEATRIZ.cpf, FERNANDO.cpf];

const COMPOSE = ['compose', '-f', 'revalle/deploy/compose.hml.yml', '--env-file', '../local-hml/hml.env'];
const compose = (...args) => execFileSync('docker', [...COMPOSE, ...args], { stdio: 'ignore' });

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
const currentToken = (recipientId) => db(`select token from "Recipient" where id = ${recipientId}`);
const attempts = (recipientId) =>
  Number(db(`select "failedAttempts" from "RevalleRecipientGate" where "recipientId" = ${recipientId}`));

beforeEach(() => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf in (${ALL_CPFS.map((c) => `'${c}'`).join(',')})`);
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

  assert.equal(res.status, 400, res.text);
  assert.equal((await verify(r.token, MARIA.cpf, MARIA.birthDate)).state.status, 'TERM_REQUIRED');
  assert.equal(
    db(
      `select count(*) from "DocumentAuditLog" where "envelopeId" = '${r.envelopeId}' and type = 'REVALLE_TERM_ACCEPTED'`,
    ),
    '0',
  );
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

test('tentativas em paralelo: exatamente 5 palpites avaliados e um bloqueio', async () => {
  const r = await newRecipient();

  await acceptTerm(r.token);
  await Promise.all(Array.from({ length: 12 }, () => verify(r.token, MARIA.cpf, '01/01/2001')));

  assert.equal(attempts(r.recipientId), 5);
  assert.equal((await verify(r.token, MARIA.cpf, MARIA.birthDate)).state.status, 'LOCKED');
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

test('rajada com um palpite certo e confirmação: no máximo 5 palpites errados e vínculo só se não bloqueou', async () => {
  const r = await newRecipient();

  await acceptTerm(r.token);

  const burst = Array.from({ length: 12 }, (_, i) =>
    i === 6 ? verify(r.token, MARIA.cpf, MARIA.birthDate) : verify(r.token, MARIA.cpf, '01/01/2001'),
  );

  burst.push(call('confirmIdentity', { token: r.token, isMe: true }));
  await Promise.all(burst);

  const failed = Number(
    db(
      `select count(*) from "DocumentAuditLog" where "envelopeId" = '${r.envelopeId}' and type = 'REVALLE_IDENTITY_FAILED'`,
    ),
  );
  const links = Number(db(`select count(*) from "RevalleEmailLink" where email = '${r.email}'`));

  assert.ok(failed <= 5, `eventos FAILED: ${failed}`);
  assert.ok(attempts(r.recipientId) <= 5);

  assert.ok(links <= 1, `vínculos: ${links}`);
});

test('confirmIdentity sem verificação prévia não cria vínculo', async () => {
  const r = await newRecipient();

  await acceptTerm(r.token);

  const res = await call('confirmIdentity', { token: r.token, isMe: true });

  assert.equal(res.state.status, 'IDENTITY_REQUIRED');
  assert.equal(db(`select count(*) from "RevalleEmailLink" where email = '${r.email}'`), '0');
});

test('confirmar (sim ou não) em portão bloqueado continua bloqueado', async () => {
  const r = await newRecipient();

  await acceptTerm(r.token);
  await verify(r.token, MARIA.cpf, MARIA.birthDate);
  db(
    `update "RevalleRecipientGate" set "lockedAt" = now(), "lockReason" = 'ATTEMPTS' where "recipientId" = ${r.recipientId}`,
  );

  assert.equal((await call('confirmIdentity', { token: r.token, isMe: true })).state.status, 'LOCKED');
  assert.equal((await call('confirmIdentity', { token: r.token, isMe: false })).state.status, 'LOCKED');
  assert.equal(db(`select count(*) from "RevalleEmailLink" where email = '${r.email}'`), '0');
});

test('conflito na confirmação: o CPF foi confirmado por outro e-mail antes', async () => {
  const a = await newRecipient();
  const b = await newRecipient();

  for (const r of [a, b]) {
    await acceptTerm(r.token);
    assert.equal((await verify(r.token, BEATRIZ.cpf, BEATRIZ.birthDate)).state.status, 'IDENTITY_CONFIRM');
  }

  assert.equal((await call('confirmIdentity', { token: b.token, isMe: true })).state.status, 'PASSED');
  assert.equal((await call('confirmIdentity', { token: a.token, isMe: true })).state.status, 'LOCKED');
  assert.equal(
    db(`select "lockReason" from "RevalleRecipientGate" where "recipientId" = ${a.recipientId}`),
    'CPF_CONFLICT',
  );
  assert.equal(db(`select count(*) from "RevalleEmailLink" where cpf = '${BEATRIZ.cpf}'`), '1');
  assert.equal(db(`select count(*) from "RevalleEmailLink" where email = '${a.email}'`), '0');

  await sleep(1500);
  assert.match((await latestMail(ADMIN_EMAIL))?.Subject ?? '', /Link de assinatura bloqueado/);
});

test('conflito na confirmação: e-mail já vinculado a outro CPF', async () => {
  const r = await newRecipient();

  await acceptTerm(r.token);
  await verify(r.token, MARIA.cpf, MARIA.birthDate);
  db(`insert into "RevalleEmailLink" (id, email, cpf) values ('t-${Date.now()}', '${r.email}', '${FERNANDO.cpf}')`);

  assert.equal((await call('confirmIdentity', { token: r.token, isMe: true })).state.status, 'LOCKED');
  assert.equal(db(`select cpf from "RevalleEmailLink" where email = '${r.email}'`), FERNANDO.cpf);
  assert.equal(db(`select count(*) from "RevalleEmailLink" where cpf = '${MARIA.cpfDigits}'`), '0');
});

test('trocar o e-mail do destinatário reinicia o portão', async () => {
  const r = await newRecipient();

  await acceptTerm(r.token);
  await verify(r.token, MARIA.cpf, MARIA.birthDate);
  assert.equal((await call('confirmIdentity', { token: r.token, isMe: true })).state.status, 'PASSED');

  const newEmail = unique();
  const upd = await api('POST', '/envelope/recipient/update-many', {
    envelopeId: r.envelopeId,
    data: [{ id: r.recipientId, email: newEmail }],
  });

  assert.equal(upd.status, 200, upd.text);

  // O e-mail novo ganha link novo (token trocado); o portão é do destinatário e recomeça.
  const token = currentToken(r.recipientId);

  assert.notEqual(token, r.token);

  const res = await verify(token, MARIA.cpf, MARIA.birthDate);

  assert.equal(res.state.status, 'TERM_REQUIRED');
  assert.equal((await acceptTerm(token)).state.status, 'IDENTITY_REQUIRED');
  assert.equal(attempts(r.recipientId), 0);
});

test('trocar o e-mail mantém o bloqueio e as tentativas', async () => {
  const locked = await newRecipient();

  await acceptTerm(locked.token);
  for (let i = 0; i < 5; i += 1) {
    await verify(locked.token, MARIA.cpf, '01/01/2001');
  }

  const upd = await api('POST', '/envelope/recipient/update-many', {
    envelopeId: locked.envelopeId,
    data: [{ id: locked.recipientId, email: unique() }],
  });

  assert.equal(upd.status, 200, upd.text);
  assert.equal((await verify(currentToken(locked.recipientId), MARIA.cpf, MARIA.birthDate)).state.status, 'LOCKED');

  const partial = await newRecipient();

  await acceptTerm(partial.token);
  for (let i = 0; i < 3; i += 1) {
    await verify(partial.token, MARIA.cpf, '01/01/2001');
  }

  await api('POST', '/envelope/recipient/update-many', {
    envelopeId: partial.envelopeId,
    data: [{ id: partial.recipientId, email: unique() }],
  });

  const partialToken = currentToken(partial.recipientId);

  assert.equal((await verify(partialToken, MARIA.cpf, MARIA.birthDate)).state.status, 'TERM_REQUIRED');
  assert.deepEqual((await acceptTerm(partialToken)).state, { status: 'IDENTITY_REQUIRED', attemptsLeft: 2 });
});

test('envelope rascunho ou concluído devolve 404', async () => {
  const draft = await createEnvelope({ recipients: [{ email: unique() }] });

  assert.equal(draft.status, 200, draft.text);

  const draftToken = draft.envelope.recipients[0].token;

  assert.equal((await acceptTerm(draftToken)).status, 404);

  const r = await newRecipient();

  db(`update "Envelope" set status = 'COMPLETED' where id = '${r.envelopeId}'`);
  assert.equal((await acceptTerm(r.token)).status, 404);
});

test('destinatário que já assinou ou é só cópia devolve 404', async () => {
  const r = await newRecipient();

  db(`update "Recipient" set "signingStatus" = 'SIGNED' where id = ${r.recipientId}`);
  assert.equal((await acceptTerm(r.token)).status, 404);

  const cc = await newRecipient();

  db(`update "Recipient" set role = 'CC' where id = ${cc.recipientId}`);
  assert.equal((await acceptTerm(cc.token)).status, 404);
});

test('base-down: base fora do ar devolve UNAVAILABLE sem consumir tentativa', async (t) => {
  const r = await newRecipient();

  await acceptTerm(r.token);
  compose('stop', 'colaboradores-db');
  t.after(waitForBase);

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
