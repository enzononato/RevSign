// Regra dos e-mails de destinatário. Fase 3: só domínios da empresa. Desde 16/11/2026 (e-mail externo): documento comum
// vai para qualquer e-mail; o placeholder de modelo continua fora do documento e o envio recusa e-mail vazio. A nota
// fiscal com e-mail de fora é coberta por `external-email.test.mjs`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { api, createEnvelope, db, distribute, trpc } from './helpers.mjs';

const PLACEHOLDER_MESSAGE = 'é um exemplo do modelo, não de uma pessoa';

test('e-mail fora da empresa é aceito na criação de documento', async () => {
  const res = await createEnvelope({ recipients: [{ email: `dominio-${Date.now()}@gmail.com` }] });

  assert.equal(res.status, 200, res.text);
  assert.ok(res.id);
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

// A API (zEmail, upstream) recusa espaços nas pontas antes da regra; a normalização com espaços
// (" Fulano@Revalle.com.br ") é coberta pelo Vitest de email-domain.
test('e-mail com espaços nas pontas é recusado pela validação de formato', async () => {
  const res = await createEnvelope({ recipients: [{ email: ' Teste@Revalle.com.br ' }] });

  assert.equal(res.status, 400, res.text);
});

test('adicionar destinatário fora da empresa a um rascunho é aceito', async () => {
  const base = await createEnvelope({ recipients: [{ email: 'ok@revalle.com.br' }] });

  assert.equal(base.status, 200, base.text);

  const email = `dominio-y-${Date.now()}@outlook.com`;
  const res = await api('POST', '/envelope/recipient/create-many', {
    envelopeId: base.id,
    data: [{ email, name: 'Y', role: 'SIGNER' }],
  });

  assert.equal(res.status, 200, res.text);
  assert.equal(db(`select count(*) from "Recipient" where "envelopeId" = '${base.id}' and email = '${email}'`), '1');
});

test('próximo assinante ditado com o placeholder do modelo é recusado e nada é gravado', async () => {
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
    nextSigner: { email: 'recipient.1@documenso.com', name: 'X' },
  });

  assert.equal(done.ok, false, done.text);
  assert.match(done.text, new RegExp(PLACEHOLDER_MESSAGE));
  assert.equal(db(`select "signingStatus" from "Recipient" where id = ${first.id}`), 'NOT_SIGNED');
});

test('destinatário sem e-mail não pode ser enviado', async () => {
  const res = await createEnvelope({ recipients: [{ email: '' }] });

  assert.equal(res.status, 200, res.text);

  const sent = await api('POST', '/envelope/distribute', { envelopeId: res.id });

  assert.equal(sent.status, 400, sent.text);
  assert.match(sent.text, /Todo destinatário precisa de um e-mail\./);
});

// Revisão final (I1): o placeholder de modelo vale só em modelo. Os parecidos são e-mails como outros quaisquer (de fora
// da empresa), aceitos desde a regra do e-mail externo.
const PLACEHOLDERS = ['recipient.1@documenso.com', 'Recipient.7@Documenso.com', 'direct.link@documenso.com'];
const LOOK_ALIKE = 'x.recipient.1@documenso.com.evil.example';

test('placeholder de modelo é recusado na criação de documento; o parecido é aceito', async () => {
  for (const email of PLACEHOLDERS) {
    const res = await createEnvelope({ recipients: [{ email }] });

    assert.equal(res.status, 400, `${email}: ${res.text}`);
    assert.match(res.text, new RegExp(PLACEHOLDER_MESSAGE));
  }

  const lookAlike = await createEnvelope({ recipients: [{ email: LOOK_ALIKE }] });

  assert.equal(lookAlike.status, 200, lookAlike.text);
});

test('placeholder de modelo é recusado no envio (gravado direto no banco)', async () => {
  for (const email of PLACEHOLDERS) {
    const base = await createEnvelope({ recipients: [{ email: `envio-${Date.now()}@revalle.com.br` }] });

    assert.equal(base.status, 200, base.text);
    db(`update "Recipient" set email = '${email.toLowerCase()}' where "envelopeId" = '${base.id}'`);

    const res = await api('POST', '/envelope/distribute', { envelopeId: base.id });

    assert.equal(res.status, 400, `${email}: ${res.text}`);
    assert.match(res.text, new RegExp(PLACEHOLDER_MESSAGE));
    assert.equal(db(`select status from "Envelope" where id = '${base.id}'`), 'DRAFT');
  }
});

test('modelo aceita o placeholder exato e e-mails de fora da empresa', async () => {
  const ok = await createEnvelope({ type: 'TEMPLATE', recipients: [{ email: 'recipient.1@documenso.com' }] });

  assert.equal(ok.status, 200, ok.text);

  const external = await createEnvelope({ type: 'TEMPLATE', recipients: [{ email: LOOK_ALIKE }] });

  assert.equal(external.status, 200, external.text);
});
