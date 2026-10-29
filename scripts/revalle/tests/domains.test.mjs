// Destinatários só de domínios da empresa (Task 2, Fase 3).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { api, createEnvelope, db, distribute, trpc } from './helpers.mjs';

const MENSAGEM = 'não é de um domínio da empresa';

test('e-mail fora da empresa é recusado na criação', async () => {
  const res = await createEnvelope({ recipients: [{ email: 'x@gmail.com' }] });

  assert.equal(res.status, 400, res.text);
  assert.match(res.text, new RegExp(MENSAGEM));
});

test('e-mail da empresa com caixa mista é aceito e gravado em minúsculas', async () => {
  const res = await createEnvelope({ recipients: [{ email: 'Teste@Revalle.com.br' }] });

  assert.equal(res.status, 200, res.text);
  assert.ok(res.id);
  assert.equal(
    db(`select r.email from "Recipient" r join "Envelope" e on e.id = r."envelopeId" where e.id = '${res.id}'`),
    'teste@revalle.com.br',
  );
});

// A API (zEmail, upstream) recusa espaços nas pontas antes da regra de domínio; a normalização
// com espaços (" Fulano@Revalle.com.br ") é coberta pelo Vitest de email-domain.
test('e-mail com espaços nas pontas é recusado pela validação de formato', async () => {
  const res = await createEnvelope({ recipients: [{ email: ' Teste@Revalle.com.br ' }] });

  assert.equal(res.status, 400, res.text);
});

test('adicionar destinatário fora da empresa a envelope existente é recusado', async () => {
  const base = await createEnvelope({ recipients: [{ email: 'ok@revalle.com.br' }] });

  assert.equal(base.status, 200, base.text);

  const res = await api('POST', '/envelope/recipient/create-many', {
    envelopeId: base.id,
    data: [{ email: 'y@outlook.com', name: 'Y', role: 'SIGNER' }],
  });

  assert.equal(res.status, 400, res.text);
  assert.match(res.text, new RegExp(MENSAGEM));
});

test('próximo assinante ditado fora da empresa é recusado e nada é gravado', async () => {
  const res = await createEnvelope({
    recipients: [
      { email: 'a@revalle.com.br', signingOrder: 1 },
      { email: 'b@revalle.com.br', signingOrder: 2 },
    ],
    meta: { allowDictateNextSigner: true, signingOrder: 'SEQUENTIAL' },
  });

  assert.equal(res.status, 200, res.text);

  const [first] = (await distribute(res.id)).filter((r) => r.email === 'a@revalle.com.br');
  const envelope = (await api('GET', `/envelope/${res.id}`)).body;
  const field = envelope.fields.find((f) => f.recipientId === first.id && f.type === 'SIGNATURE');
  const documentId = Number.parseInt(envelope.secondaryId.split('_')[1], 10);

  await trpc('envelope.field.sign', {
    token: first.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Teste' },
  });

  const done = await trpc('recipient.completeDocumentWithToken', {
    token: first.token,
    documentId,
    nextSigner: { email: 'x@gmail.com', name: 'X' },
  });

  assert.equal(done.ok, false, done.text);
  assert.match(done.text, new RegExp(MENSAGEM));
  assert.equal(db(`select "signingStatus" from "Recipient" where id = ${first.id}`), 'NOT_SIGNED');
});

test('destinatário sem e-mail não pode ser enviado', async () => {
  const res = await createEnvelope({ recipients: [{ email: '' }] });

  assert.equal(res.status, 200, res.text);

  const sent = await api('POST', '/envelope/distribute', { envelopeId: res.id });

  assert.equal(sent.status, 400, sent.text);
  assert.match(sent.text, /Todo destinatário precisa de um e-mail da empresa/);
});

// Revisão final (I1): sem exceção de placeholder em documento, envio e conclusão; o placeholder vale só em modelo.
const LOOK_ALIKES = [
  'x.recipient.1@documenso.com.evil.example',
  'recipient.1@documenso.com',
  'direct.link@documenso.com',
];

test('placeholder de modelo e parecidos são recusados na criação de documento', async () => {
  for (const email of LOOK_ALIKES) {
    const res = await createEnvelope({ recipients: [{ email }] });

    assert.equal(res.status, 400, `${email}: ${res.text}`);
    assert.match(res.text, new RegExp(MENSAGEM));
  }
});

test('placeholder de modelo e parecidos são recusados no envio (gravados direto no banco)', async () => {
  for (const email of LOOK_ALIKES) {
    const base = await createEnvelope({ recipients: [{ email: `envio-${Date.now()}@revalle.com.br` }] });

    assert.equal(base.status, 200, base.text);
    db(`update "Recipient" set email = '${email}' where "envelopeId" = '${base.id}'`);

    const res = await api('POST', '/envelope/distribute', { envelopeId: base.id });

    assert.equal(res.status, 400, `${email}: ${res.text}`);
    assert.match(res.text, new RegExp(MENSAGEM));
    assert.equal(db(`select status from "Envelope" where id = '${base.id}'`), 'DRAFT');
  }
});

test('modelo ainda aceita o placeholder exato, mas não o parecido', async () => {
  const ok = await createEnvelope({ type: 'TEMPLATE', recipients: [{ email: 'recipient.1@documenso.com' }] });

  assert.equal(ok.status, 200, ok.text);

  const evil = await createEnvelope({
    type: 'TEMPLATE',
    recipients: [{ email: 'x.recipient.1@documenso.com.evil.example' }],
  });

  assert.equal(evil.status, 400, evil.text);
});
