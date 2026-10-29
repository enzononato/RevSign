// Página pública /verificar (Task 4, Fase 4). Roda contra a stack local.
import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';

import { BASE_URL, completeWithCode, createEnvelope, db, distribute, trpc } from './helpers.mjs';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const title = `[TESTE] verificar ${Date.now()}`;
const email = `verificar-${Date.now()}@revalle.com.br`;
let code;

const page = (codigo, headers = {}) =>
  fetch(`${BASE_URL}/verificar?codigo=${encodeURIComponent(codigo)}`, { headers }).then(async (res) => ({
    status: res.status,
    html: await res.text(),
  }));

before(async () => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);

  const created = await createEnvelope({ title, recipients: [{ email }] });

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);
  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const field = created.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');
  const { token } = recipient;

  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
  await trpc('envelope.field.sign', { token, fieldId: field.id, fieldValue: { type: 'SIGNATURE', value: 'Teste' } });
  assert.equal((await completeWithCode({ token, documentId, email })).status, 200);

  code = db(
    `select p."verificationCode" from "RevalleSignatureProof" p join "Recipient" r on r.id = p."recipientId" where r."envelopeId" = '${created.id}'`,
  );
  assert.match(code, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
});

beforeEach(() => {
  db('delete from "RateLimit"');
});

test('código válido mostra título, CPF mascarado e nada sensível', async () => {
  const { status, html } = await page(code);

  assert.equal(status, 200);
  assert.ok(html.includes(title), 'título ausente');
  assert.ok(html.includes('Maria Teste da Silva'));
  assert.match(html, /\*\*\*\.\d{3}\.\d{3}-\*\*/);
  assert.ok(!html.includes(MARIA.cpf), 'CPF completo na página');
  assert.ok(!html.includes(email), 'e-mail na página');
  assert.ok(!html.includes('203.0.113'), 'IP na página');
  assert.match(html, /horário de Brasília/);
  assert.ok(html.includes('Verificar documento · RevSign'));
});

test('aceita minúsculas e sem hífen', async () => {
  const { html } = await page(code.replace('-', '').toLowerCase());

  assert.ok(html.includes(title));
});

test('código inexistente ou malformado responde "Código não encontrado."', async () => {
  for (const bad of ['ZZZZ-ZZZZ', '0000-1111', 'abc', "' OR 1=1 --", '<script>']) {
    const { status, html } = await page(bad);

    assert.equal(status, 200, bad);
    assert.ok(html.includes('Código não encontrado.'), bad);
    assert.ok(!html.includes(title));
  }
});

test('malformado não consome o limite', async () => {
  for (let i = 0; i < 40; i += 1) {
    await page('abc');
  }

  assert.equal(db(`select count(*) from "RateLimit" where action = 'revalle.verify'`), '0');
});

test('a 31ª consulta em 15 min devolve 429', async () => {
  const headers = { 'X-Forwarded-For': '198.51.100.77' };

  for (let i = 0; i < 30; i += 1) {
    assert.equal((await page(code, headers)).status, 200, `consulta ${i + 1}`);
  }

  const limited = await page(code, headers);

  assert.equal(limited.status, 429);
  assert.ok(limited.html.includes('Muitas consultas. Tente novamente em alguns minutos.'));
});

test('/share/<slug> que não é qr_ vira 404, sem redirecionar', async () => {
  const res = await fetch(`${BASE_URL}/share/abc123`, { redirect: 'manual' });

  assert.equal(res.status, 404);
});
