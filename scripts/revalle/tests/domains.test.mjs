// Destinatários só de domínios da empresa (Task 2, Fase 3).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { api, createEnvelope, db } from './helpers.mjs';

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
