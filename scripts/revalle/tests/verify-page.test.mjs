// Página pública /verificar (Task 4, Fase 4). Roda contra a stack local.
import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';

import { BASE_URL, completeWithCode, createEnvelope, db, distribute, trpc } from './helpers.mjs';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const VIEWER_NAME = 'Vera Visualizadora Teste';
const title = `[TESTE] verificar ${Date.now()}`;
const email = `verificar-${Date.now()}@revalle.com.br`;
let code;
const fx = {};

const gate = async (token) => {
  // Um CPF só vale para um e-mail: solta o vínculo anterior (a prova e o portão ficam).
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

const unique = (label) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@revalle.com.br`;

const codeOf = (envelopeId, recipientId) =>
  db(
    `select p."verificationCode" from "RevalleSignatureProof" p join "Recipient" r on r.id = p."recipientId" where r."envelopeId" = '${envelopeId}'${recipientId ? ` and r.id = ${recipientId}` : ''} limit 1`,
  );

const waitStatus = async (envelopeId, status) => {
  for (let i = 0; i < 40 && db(`select status from "Envelope" where id = '${envelopeId}'`) !== status; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

// Envelope com um signatário que conclui + um segundo participante (`second`).
const twoParty = async ({ role, action, name }) => {
  const t = `[TESTE] verificar-${role}-${action} ${Date.now()}`;
  const first = unique('a');
  const other = unique('b');
  const created = await createEnvelope({
    title: t,
    recipients: [
      { email: first },
      { email: other, role, ...(name ? { name } : {}), ...(role === 'SIGNER' ? {} : { fields: [] }) },
    ],
  });

  assert.equal(created.status, 200, created.text);

  const recipients = await distribute(created.id);
  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const a = recipients.find((r) => r.email === first);
  const b = recipients.find((r) => r.email === other);
  const field = created.envelope.fields.find((f) => f.recipientId === a.id && f.type === 'SIGNATURE');

  await gate(a.token);
  await trpc('envelope.field.sign', {
    token: a.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Teste' },
  });
  assert.equal((await completeWithCode({ token: a.token, documentId, email: first })).status, 200);

  if (action === 'reject') {
    await gate(b.token);
    const res = await trpc('recipient.rejectDocumentWithToken', { token: b.token, documentId, reason: 'Teste' });

    assert.equal(res.status, 200, res.text);
    await waitStatus(created.id, 'REJECTED');
  } else if (action === 'complete') {
    await gate(b.token);
    assert.equal((await completeWithCode({ token: b.token, documentId, email: other })).status, 200);
  }

  return { title: t, id: created.id, a, b };
};

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
  fx.main = created.id;

  fx.rejected = await twoParty({ role: 'SIGNER', action: 'reject' });
  fx.pending = await twoParty({ role: 'SIGNER', action: 'none' });
  fx.viewer = await twoParty({ role: 'VIEWER', action: 'complete', name: VIEWER_NAME });
  fx.deleted = await twoParty({ role: 'SIGNER', action: 'none' });
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

// 31 consultas seguidas; `ipOf(i)` dá o IP da i-ésima. O limite usa janelas fixas de 15 min: se as 31 cruzarem a
// virada da janela (contadores em dois baldes), a rodada não vale e é repetida uma vez (a nova cabe numa janela só).
const burst = async (ipOf, key) => {
  const run = async () => {
    db('delete from "RateLimit"');

    const statuses = [];
    let last;

    for (let i = 0; i < 31; i += 1) {
      last = await page(code, { 'X-Forwarded-For': ipOf(i) });
      statuses.push(last.status);
    }

    const buckets = db(
      `select count(distinct bucket) from "RateLimit" where action = 'revalle.verify' and key = 'ip:${key}'`,
    );

    return { statuses, last, buckets };
  };

  const first = await run();
  const result = first.buckets === '1' ? first : await run();

  assert.equal(result.buckets, '1', 'as consultas cruzaram a virada da janela duas vezes');

  return result;
};

test('a 31ª consulta em 15 min devolve 429', async () => {
  const { statuses, last } = await burst(() => '198.51.100.77', '198.51.100.77');

  assert.deepEqual(statuses.slice(0, 30), Array(30).fill(200));
  assert.equal(statuses[30], 429);
  assert.ok(last.html.includes('Muitas consultas. Tente novamente em alguns minutos.'));
});

test('IPv6: endereços da mesma /64 dividem o limite', async () => {
  const { statuses } = await burst((i) => `2001:db8:77:1::${(i + 1).toString(16)}`, '2001:db8:77:1::/64');

  assert.deepEqual(statuses.slice(0, 30), Array(30).fill(200));
  assert.equal(statuses[30], 429);
});

test('/share/<slug> que não é qr_ vira 404, sem redirecionar', async () => {
  const res = await fetch(`${BASE_URL}/share/abc123`, { redirect: 'manual' });

  assert.equal(res.status, 404);
});

test('envelope recusado mostra "Recusado em" e o participante que assinou', async () => {
  const { html } = await page(codeOf(fx.rejected.id));

  assert.ok(html.includes(fx.rejected.title));
  assert.match(html, /Recusado em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} \(horário de Brasília\)/);
  assert.ok(!html.includes('Concluído em'));
});

test('envelope em andamento mostra "Em andamento" e nenhum hash final', async () => {
  const { html } = await page(codeOf(fx.pending.id));

  assert.ok(html.includes('Em andamento'));
  assert.ok(!html.includes('SHA-256 do documento final'));
  assert.ok(!/[0-9a-f]{64}/.test(html));
});

test('participante VIEWER aparece com o nome do destinatário e "Visualizou em"', async () => {
  const { html } = await page(codeOf(fx.viewer.id, fx.viewer.b.id));

  assert.ok(html.includes('Visualizou em'), 'rótulo do VIEWER ausente');
  assert.ok(html.includes('Participantes'));
  // Sem dados do RH (VIEWER não passa pelo portão): vale o nome do destinatário, como no carimbo e no certificado.
  assert.ok(html.includes(VIEWER_NAME), 'nome do VIEWER ausente');
  assert.ok(!html.includes('Signatário'), 'rótulo genérico "Signatário" no lugar do nome');
  assert.ok(!html.includes(fx.viewer.b.email), 'e-mail do VIEWER na página');
});

test('envelope excluído (deletedAt) vira "Código não encontrado."', async () => {
  const c = codeOf(fx.deleted.id);

  assert.ok((await page(c)).html.includes(fx.deleted.title));
  db(`update "Envelope" set "deletedAt" = now() where id = '${fx.deleted.id}'`);

  const { html } = await page(c);

  assert.ok(html.includes('Código não encontrado.'));
  assert.ok(!html.includes(fx.deleted.title));
});
