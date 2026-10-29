// Localização do aparelho na conclusão (Task 5, Fase 4). Roda contra a stack local.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { completeWithCode, createEnvelope, db, distribute, trpc } from './helpers.mjs';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };

const readProof = (id) =>
  JSON.parse(
    db(
      `select row_to_json(p) from "RevalleSignatureProof" p join "Recipient" r on r.id = p."recipientId" where r."envelopeId" = '${id}'`,
    ) || 'null',
  );

const recipientStatus = (id) => db(`select "signingStatus" from "Recipient" where "envelopeId" = '${id}'`).trim();

const flow = async (extra) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  const email = `geo-${Date.now()}-${Math.floor(Math.random() * 1e6)}@revalle.com.br`;
  const created = await createEnvelope({ recipients: [{ email }] });

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);
  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const field = created.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');
  const { token } = recipient;

  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
  await trpc('envelope.field.sign', { token, fieldId: field.id, fieldValue: { type: 'SIGNATURE', value: 'Teste' } });

  const res = await completeWithCode({ token, documentId, email, extra });

  return { res, id: created.id };
};

beforeEach(() => {
  db('delete from "RateLimit"');
});

test('ausente grava NOT_REQUESTED', async () => {
  const { res, id } = await flow({});

  assert.equal(res.status, 200, res.text);
  assert.equal(readProof(id).deviceLocation.status, 'NOT_REQUESTED');
});

test('DENIED e UNAVAILABLE são gravados e a conclusão segue', async () => {
  for (const status of ['DENIED', 'UNAVAILABLE']) {
    const { res, id } = await flow({ revalleGeolocation: { status } });

    assert.equal(res.status, 200, res.text);
    assert.equal(readProof(id).deviceLocation.status, status);
    assert.equal(recipientStatus(id), 'SIGNED');
  }
});

test('GRANTED grava lat/lon a 5 casas e precisão inteira', async () => {
  const { res, id } = await flow({
    revalleGeolocation: { status: 'GRANTED', lat: -12.9714159, lon: -38.5014199, accuracyM: 19.6 },
  });

  assert.equal(res.status, 200, res.text);
  assert.deepEqual(readProof(id).deviceLocation, { status: 'GRANTED', lat: -12.97142, lon: -38.50142, accuracyM: 20 });
});

test('malformado (lat 200) dá 400 e o destinatário segue NOT_SIGNED', async () => {
  const { res, id } = await flow({ revalleGeolocation: { status: 'GRANTED', lat: 200, lon: 0, accuracyM: 5 } });

  assert.equal(res.status, 400);
  assert.equal(recipientStatus(id), 'NOT_SIGNED');
  assert.equal(readProof(id), null);
});

test('VIEWER (sem portão nem termo) que manda GRANTED fica com NOT_REQUESTED', async () => {
  const signer = `geo-s-${Date.now()}-${Math.floor(Math.random() * 1e6)}@revalle.com.br`;
  const viewer = `geo-v-${Date.now()}-${Math.floor(Math.random() * 1e6)}@revalle.com.br`;
  const created = await createEnvelope({
    recipients: [{ email: signer }, { email: viewer, role: 'VIEWER', fields: [] }],
  });

  assert.equal(created.status, 200, created.text);

  const recipients = await distribute(created.id);
  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const v = recipients.find((r) => r.email === viewer);
  const res = await completeWithCode({
    token: v.token,
    documentId,
    email: viewer,
    extra: { revalleGeolocation: { status: 'GRANTED', lat: -12.9714159, lon: -38.5014199, accuracyM: 19.6 } },
  });

  assert.equal(res.status, 200, res.text);

  const proof = JSON.parse(
    db(`select row_to_json(p) from "RevalleSignatureProof" p where p."recipientId" = ${v.id}`) || 'null',
  );

  assert.deepEqual(proof.deviceLocation, { status: 'NOT_REQUESTED' });
});
