// Portão obrigatório no servidor (Task 6, Fase 3): nenhuma rota por token funciona antes do portão (a API não contorna a tela).
// Pessoas fictícias da base de desenvolvimento: revalle/colaboradores/dev-seed.sql.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { api, BASE_URL, createEnvelope, db, distribute, trpc } from './helpers.mjs';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const ANA = { cpf: '74612058380', birthDate: '15/01/1978' };
const CPFS = [MARIA.cpf, ANA.cpf];
const GATE_MESSAGE = /Conclua a verificação/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unique = (tag) => `gateapi-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@revalle.com.br`;

const gate = (procedure, input) => trpc(`revalle.gate.${procedure}`, input);

const passGate = async (token, person) => {
  assert.equal((await gate('acceptTerm', { token, termVersion: '1' })).status, 200);

  const verified = await gate('verifyIdentity', { token, cpf: person.cpf, birthDate: person.birthDate });

  assert.equal(verified.body?.result?.data?.json?.status, 'IDENTITY_CONFIRM', verified.text);

  const confirmed = await gate('confirmIdentity', { token, isMe: true });

  assert.equal(confirmed.body?.result?.data?.json?.status, 'PASSED', confirmed.text);
};

const setup = async (recipients, meta) => {
  const created = await createEnvelope({ recipients, meta });

  assert.equal(created.status, 200, created.text);

  const distributed = await distribute(created.id);
  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);

  return {
    envelopeId: created.id,
    documentId,
    envelope: created.envelope,
    recipients: distributed.map((r) => ({
      ...r,
      field: created.envelope.fields.find((f) => f.recipientId === r.id && f.type === 'SIGNATURE'),
    })),
  };
};

const sign = (r) =>
  trpc('envelope.field.sign', {
    token: r.token,
    fieldId: r.field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Teste' },
  });
const complete = (r, documentId) => trpc('recipient.completeDocumentWithToken', { token: r.token, documentId });

const waitCompleted = async (envelopeId) => {
  for (let i = 0; i < 60; i += 1) {
    if ((await api('GET', `/envelope/${envelopeId}`)).body.status === 'COMPLETED') {
      return;
    }

    await sleep(3000);
  }

  throw new Error('documento não foi selado a tempo');
};

beforeEach(() => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf in (${CPFS.map((c) => `'${c}'`).join(',')})`);
});

test('gate-blocks-api: com o portão pendente todas as rotas por token recusam', async () => {
  const s = await setup([{ email: unique('block') }], { distributionMethod: 'NONE' });
  const [r] = s.recipients;
  const itemId = s.envelope.envelopeItems[0].id;

  const signed = await sign(r);

  assert.notEqual(signed.status, 200, signed.text);
  assert.match(signed.text, GATE_MESSAGE);

  const completed = await complete(r, s.documentId);

  assert.notEqual(completed.status, 200, completed.text);
  assert.match(completed.text, GATE_MESSAGE);

  const legacySigned = await trpc('field.signFieldWithToken', {
    token: r.token,
    fieldId: r.field.id,
    value: 'Teste',
    isBase64: false,
  });

  assert.notEqual(legacySigned.status, 200, legacySigned.text);
  assert.match(legacySigned.text, GATE_MESSAGE);

  const removed = await trpc('field.removeSignedFieldWithToken', { token: r.token, fieldId: r.field.id });

  assert.notEqual(removed.status, 200, removed.text);
  assert.match(removed.text, GATE_MESSAGE);

  const items = await fetch(
    `${BASE_URL}/api/trpc/envelope.items.getByToken?input=${encodeURIComponent(
      JSON.stringify({ json: { envelopeId: s.envelopeId, access: { type: 'recipient', token: r.token } } }),
    )}`,
  );

  assert.notEqual(items.status, 200, await items.text());

  for (const route of [
    `/api/files/token/${r.token}/envelopeItem/${itemId}`,
    `/api/files/token/${r.token}/envelopeItem/${itemId}/download/original`,
  ]) {
    const pdf = await fetch(`${BASE_URL}${route}`);

    assert.ok([401, 403].includes(pdf.status), `${route} => ${pdf.status}`);
  }

  const rejected = await trpc('recipient.rejectDocumentWithToken', {
    token: r.token,
    documentId: s.documentId,
    reason: 'não quero',
  });

  assert.notEqual(rejected.status, 200, rejected.text);
  assert.match(rejected.text, GATE_MESSAGE);
  assert.equal((await api('GET', `/envelope/${s.envelopeId}`)).body.status, 'PENDING');
});

test('depois do portão: PDF por token abre, assina e o documento é selado', async () => {
  const s = await setup([{ email: unique('ok') }], { distributionMethod: 'NONE' });
  const [r] = s.recipients;
  const itemId = s.envelope.envelopeItems[0].id;

  await passGate(r.token, MARIA);

  const pdf = await fetch(`${BASE_URL}/api/files/token/${r.token}/envelopeItem/${itemId}`);

  assert.equal(pdf.status, 200);

  const signed = await sign(r);

  assert.equal(signed.status, 200, signed.text);

  const completed = await complete(r, s.documentId);

  assert.equal(completed.status, 200, completed.text);

  await waitCompleted(s.envelopeId);
});

test('sequencial: o segundo não assina antes do primeiro; cada um passa pelo próprio portão; selagem no fim', async () => {
  const s = await setup(
    [
      { email: unique('seq1'), signingOrder: 1 },
      { email: unique('seq2'), signingOrder: 2 },
    ],
    { distributionMethod: 'NONE', signingOrder: 'SEQUENTIAL' },
  );
  const [first, second] = s.recipients;

  await passGate(second.token, ANA);

  const earlyComplete = await complete(second, s.documentId);

  assert.notEqual(earlyComplete.status, 200, earlyComplete.text);

  // O portão do primeiro continua pendente: o portão do segundo não vale para ele.
  const firstBlocked = await sign(first);

  assert.match(firstBlocked.text, GATE_MESSAGE);

  await passGate(first.token, MARIA);

  assert.equal((await sign(first)).status, 200);
  assert.equal((await complete(first, s.documentId)).status, 200);

  assert.equal((await sign(second)).status, 200);
  assert.equal((await complete(second, s.documentId)).status, 200);

  await waitCompleted(s.envelopeId);
});
