// SHA-256 do PDF original (no envio) e do selado (Task 2, Fase 4). Roda contra a stack local.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, beforeEach, test } from 'node:test';

import { api, BASE_URL, completeWithCode, createEnvelope, db, distribute, trpc } from './helpers.mjs';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const download = async (itemId, version) => {
  const res = await fetch(`${BASE_URL}/api/v2-beta/envelope/item/${itemId}/download?version=${version}`, {
    headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` },
  });

  assert.equal(res.status, 200);

  return Buffer.from(await res.arrayBuffer());
};

let itemId;
let afterSend;
let afterSeal;
let originalDownload;
let signedDownload;

beforeEach(() => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
});

before(async () => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);

  const email = `hash-${Date.now()}@revalle.com.br`;
  const created = await createEnvelope({ recipients: [{ email }] });

  assert.equal(created.status, 200, created.text);

  itemId = created.envelope.envelopeItems[0].id;

  const [recipient] = await distribute(created.id);

  afterSend = db(
    `select "originalSha256", coalesce("finalSha256", '') from "RevalleDocumentHash" where "envelopeItemId" = '${itemId}'`,
  ).trim();
  originalDownload = await download(itemId, 'original');

  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const field = created.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');
  const { token } = recipient;

  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
  assert.equal(
    (await trpc('envelope.field.sign', { token, fieldId: field.id, fieldValue: { type: 'SIGNATURE', value: 'Teste' } }))
      .status,
    200,
  );
  assert.equal((await completeWithCode({ token, documentId, email })).status, 200);

  for (let i = 0; i < 60; i += 1) {
    if ((await api('GET', `/envelope/${created.id}`)).body.status === 'COMPLETED') {
      break;
    }

    await sleep(3000);
  }

  signedDownload = await download(itemId, 'signed');
  afterSeal = db(
    `select "originalSha256", "finalSha256" from "RevalleDocumentHash" where "envelopeItemId" = '${itemId}'`,
  ).trim();
});

test('depois do envio existe o hash original e ainda não o final', () => {
  const [original, final] = afterSend.split('|');

  assert.match(original, /^[0-9a-f]{64}$/);
  assert.equal(final, '');
});

test('o hash original é o SHA-256 do download version=original', () => {
  assert.equal(afterSeal.split('|')[0], sha256(originalDownload));
});

test('o hash final é o SHA-256 do download version=signed', () => {
  assert.equal(afterSeal.split('|')[1], sha256(signedDownload));
});

test('original e final são diferentes e o original não muda na selagem', () => {
  const [original, final] = afterSeal.split('|');

  assert.notEqual(original, final);
  assert.equal(original, afterSend.split('|')[0]);
});
