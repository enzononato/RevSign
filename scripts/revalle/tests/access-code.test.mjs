// Código por e-mail sempre exigido (Task 8, Fase 3). Rodam contra a stack local.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { api, completeWithCode, createEnvelope, db, distribute, getLatestCode, trpc } from './helpers.mjs';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unique = (tag) => `code-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@revalle.com.br`;

const passGate = async (token) => {
  assert.equal((await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' })).status, 200);

  const verified = await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });

  assert.equal(verified.body?.result?.data?.json?.status, 'IDENTITY_CONFIRM', verified.text);

  const confirmed = await trpc('revalle.gate.confirmIdentity', { token, isMe: true });

  assert.equal(confirmed.body?.result?.data?.json?.status, 'PASSED', confirmed.text);
};

const setup = async () => {
  const created = await createEnvelope({ recipients: [{ email: unique('r') }] });

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);
  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const field = created.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');

  await passGate(recipient.token);

  const signed = await trpc('envelope.field.sign', {
    token: recipient.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Teste' },
  });

  assert.equal(signed.status, 200, signed.text);

  return { id: created.id, recipient, documentId };
};

beforeEach(() => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
});

test('o envelope criado sem autenticação sai com o código por e-mail exigido', async () => {
  const created = await createEnvelope({ recipients: [{ email: unique('auth') }] });

  assert.equal(created.status, 200, created.text);
  assert.deepEqual(
    db(`select "authOptions"->'globalAccessAuth' from "Envelope" where id = '${created.id}'`).replace(/\s/g, ''),
    '["TWO_FACTOR_AUTH"]',
  );

  await distribute(created.id);

  assert.match(db(`select "authOptions"::text from "Envelope" where id = '${created.id}'`), /TWO_FACTOR_AUTH/);
});

test('o backstop do envio recoloca o código se a opção tiver sido apagada', async () => {
  const created = await createEnvelope({ recipients: [{ email: unique('back') }] });

  db(
    `update "Envelope" set "authOptions" = '{"globalAccessAuth":[],"globalActionAuth":[]}' where id = '${created.id}'`,
  );

  await distribute(created.id);

  assert.match(db(`select "authOptions"::text from "Envelope" where id = '${created.id}'`), /TWO_FACTOR_AUTH/);
});

test('concluir sem código ou com código errado é recusado', async () => {
  const s = await setup();
  const none = await trpc('recipient.completeDocumentWithToken', {
    token: s.recipient.token,
    documentId: s.documentId,
  });

  assert.notEqual(none.status, 200, none.text);

  const wrong = await trpc('recipient.completeDocumentWithToken', {
    token: s.recipient.token,
    documentId: s.documentId,
    accessAuthOptions: { type: 'TWO_FACTOR_AUTH', method: 'email', token: '000000' },
  });

  assert.notEqual(wrong.status, 200, wrong.text);
  assert.equal(db(`select "signingStatus" from "Recipient" where id = ${s.recipient.id}`), 'NOT_SIGNED');
});

test('com o código do e-mail conclui, e os eventos do código trazem IP e navegador', async () => {
  const s = await setup();
  const done = await completeWithCode({
    token: s.recipient.token,
    documentId: s.documentId,
    email: s.recipient.email,
  });

  assert.equal(done.status, 200, done.text);
  assert.ok(await getLatestCode(s.recipient.email));

  for (let i = 0; i < 60; i += 1) {
    if ((await api('GET', `/envelope/${s.id}`)).body.status === 'COMPLETED') {
      break;
    }

    await sleep(3000);
  }

  assert.equal((await api('GET', `/envelope/${s.id}`)).body.status, 'COMPLETED');

  for (const type of ['DOCUMENT_ACCESS_AUTH_2FA_REQUESTED', 'DOCUMENT_ACCESS_AUTH_2FA_VALIDATED']) {
    const row = db(
      `select coalesce("ipAddress",''), coalesce("userAgent",'') from "DocumentAuditLog" where "envelopeId" = '${s.id}' and type = '${type}'`,
    );

    assert.match(row, /^203\.0\.113\.7\|revsign-gate-test$/, `${type}: ${row}`);
  }
});
