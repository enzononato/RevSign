// Comprovante de envio e situação de cada envio (pedido de 16/11/2026). Roda contra a stack local.
// Requer REVSIGN_API_TOKEN e REVSIGN_USER_EMAIL/REVSIGN_USER_PASSWORD (dono do token). O "de fora" é uma conta nova.
//
// - Cada e-mail com o link de assinatura entregue ao servidor gera um evento REVALLE_SEND_RECEIPT (nome, e-mail, papel,
//   SHA-256 do arquivo original); o reenvio gera outro, com isResend.
// - O PDF do comprovante sai para o dono (pdftotext com nome, e-mail, título, SHA-256 e horário de Brasília) e dá 404 para
//   quem é de fora e para comprovante de outro envelope.
// - A situação de cada destinatário (rota `documents/:id/envios`): Enviado → Visualizado (abriu o link: portão ou documento)
//   → Assinado; recusa = Recusado.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';

import { sessionFor } from './account-helpers.mjs'; // conta obrigatória: sessão de quem recebe no e-mail da empresa
import {
  api,
  BASE_URL,
  brasilia,
  completeWithCode,
  createConfirmedAccount,
  createEnvelope,
  db,
  distribute,
  downloadItem,
  poppler,
  signIn,
  trpc,
} from './helpers.mjs';

const USER_EMAIL = process.env.REVSIGN_USER_EMAIL;
const USER_PASSWORD = process.env.REVSIGN_USER_PASSWORD;
const skip = !(process.env.REVSIGN_API_TOKEN && USER_EMAIL && USER_PASSWORD) && 'sem token/usuário do teste';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
// Destinatários de fora da empresa: assinam sem conta (CPF + data de nascimento), a regra da conta obrigatória é só do
// e-mail da empresa. A conta "de fora do time" é de e-mail da empresa (cadastro).
const unique = (label) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@gmail.com`;
const companyEmail = (label) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@revalle.com.br`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const fx = {};

const receiptRows = (envelopeId) =>
  db(
    // O banco guarda UTC sem fuso: sai com "Z" para o `new Date` não ler como hora local.
    `select coalesce(json_agg(json_build_object('data', data, 'createdAt', to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by "createdAt", id), '[]') from "DocumentAuditLog" where "envelopeId" = '${envelopeId}' and type = 'REVALLE_SEND_RECEIPT'`,
  );

const receiptsOf = (envelopeId) => JSON.parse(receiptRows(envelopeId));

// O convite sai pelo job (assíncrono): espera até `count` comprovantes.
const waitReceipts = async (envelopeId, count, timeoutMs = 60_000) => {
  const deadline = performance.now() + timeoutMs;
  let rows = receiptsOf(envelopeId);

  while (rows.length < count && performance.now() < deadline) {
    await sleep(500);
    rows = receiptsOf(envelopeId);
  }

  return rows;
};

const teamUrlOf = (envelopeId) =>
  db(`select t.url from "Team" t join "Envelope" e on e."teamId" = t.id where e.id = '${envelopeId}'`);

const get = (pathname, cookie) =>
  fetch(`${BASE_URL}${pathname}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });

const sendStatus = async (envelopeId, cookie) => {
  const res = await get(`/t/${fx.teamUrl}/documents/${envelopeId}/envios`, cookie);

  assert.equal(res.status, 200, await res.clone().text());

  return await res.json();
};

const stepsOf = (status, recipientId) =>
  Object.fromEntries(
    (status.recipients.find((item) => item.recipientId === recipientId)?.steps ?? []).map((step) => [
      step.key,
      step.reached,
    ]),
  );

const gate = async (token) => {
  // Um CPF só vale para um e-mail: solta o vínculo anterior (a prova e o portão ficam).
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

before(async () => {
  if (skip) {
    return;
  }

  fx.cookie = await signIn(USER_EMAIL, USER_PASSWORD);
  fx.title = `[TESTE] comprovante ${randomUUID().slice(0, 8)}`;
  fx.signerEmail = unique('comprovante-a');
  fx.otherEmail = unique('comprovante-b');

  const created = await createEnvelope({
    title: fx.title,
    meta: { distributionMethod: 'EMAIL' },
    recipients: [
      { email: fx.signerEmail, name: 'Ana Comprovante' },
      { email: fx.otherEmail, name: 'Bruno Comprovante' },
    ],
  });

  assert.equal(created.status, 200, created.text);

  fx.id = created.id;
  fx.envelope = created.envelope;
  fx.documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  fx.recipients = await distribute(created.id);
  fx.signer = fx.recipients.find((recipient) => recipient.email === fx.signerEmail);
  fx.other = fx.recipients.find((recipient) => recipient.email === fx.otherEmail);
  fx.teamUrl = teamUrlOf(created.id);
  fx.itemId = created.envelope.envelopeItems[0].id;
  fx.originalSha = sha256(await downloadItem(fx.itemId, 'original'));
});

test('envio para 2 destinatários: 2 comprovantes com nome, e-mail, papel e SHA-256 do arquivo', { skip }, async () => {
  const rows = await waitReceipts(fx.id, 2);

  assert.equal(rows.length, 2, JSON.stringify(rows));

  const byEmail = new Map(rows.map((row) => [row.data.recipientEmail, row.data]));

  for (const [recipient, name] of [
    [fx.signer, 'Ana Comprovante'],
    [fx.other, 'Bruno Comprovante'],
  ]) {
    const data = byEmail.get(recipient.email);

    assert.ok(data, `sem comprovante para ${recipient.email}`);
    assert.equal(data.recipientId, recipient.id);
    assert.equal(data.recipientName, name);
    assert.equal(data.recipientRole, 'SIGNER');
    assert.equal(data.channel, 'EMAIL');
    assert.equal(data.isResend, false);
    assert.equal(data.envelopeTitle, fx.title);
    assert.ok(data.receiptId);
    assert.deepEqual(
      data.documents.map((document) => document.sha256),
      [fx.originalSha],
    );
    // Nunca token nem CPF no comprovante.
    assert.ok(!JSON.stringify(data).includes(recipient.token), 'o comprovante não pode ter o token');
  }

  // O mesmo SHA-256 que o /verificar guarda como original.
  assert.equal(
    db(`select "originalSha256" from "RevalleDocumentHash" where "envelopeItemId" = '${fx.itemId}'`),
    fx.originalSha,
  );
});

test('reenvio gera um comprovante novo com isResend', { skip }, async () => {
  await waitReceipts(fx.id, 2);

  const res = await api('POST', '/envelope/redistribute', { envelopeId: fx.id, recipients: [fx.other.id] });

  assert.equal(res.status, 200, res.text);

  const rows = await waitReceipts(fx.id, 3);
  const resends = rows.filter((row) => row.data.isResend);

  assert.equal(rows.length, 3, JSON.stringify(rows));
  assert.equal(resends.length, 1);
  assert.equal(resends[0].data.recipientId, fx.other.id);
  assert.equal(resends[0].data.recipientEmail, fx.otherEmail);
  assert.notEqual(resends[0].data.receiptId, rows[0].data.receiptId);
});

test('PDF do comprovante: o dono baixa; de fora e comprovante de outro envelope dão 404', { skip }, async () => {
  const [row] = (await waitReceipts(fx.id, 2)).filter((item) => item.data.recipientEmail === fx.signerEmail);
  const href = `/t/${fx.teamUrl}/documents/${fx.id}/comprovantes/${row.data.receiptId}`;

  const res = await get(href, fx.cookie);

  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get('content-type'), 'application/pdf');

  const dir = mkdtempSync(path.join(tmpdir(), 'revsign-receipt-'));

  try {
    writeFileSync(path.join(dir, 'comprovante.pdf'), Buffer.from(await res.arrayBuffer()));

    const text = poppler(dir, 'pdftotext -layout /pdf/comprovante.pdf -');

    assert.match(text, /Comprovante de envio/);
    assert.match(text, /RevSign/);
    assert.ok(text.includes('Ana Comprovante'), text);
    assert.ok(text.includes(fx.signerEmail), text);
    assert.ok(text.includes(fx.title), text);
    assert.ok(text.includes(fx.originalSha), text);
    assert.ok(text.includes(row.data.receiptId), text);
    assert.ok(text.includes(brasilia(row.createdAt)), `sem ${brasilia(row.createdAt)}:\n${text}`);
    assert.match(text, /horário de Brasília/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Mesmo evento = mesmo conteúdo.
  const again = await get(href, fx.cookie);
  assert.equal(again.status, 200);

  // Sem sessão.
  assert.equal((await get(href)).status, 401);

  // Conta de fora do time.
  const outsider = await createConfirmedAccount({
    email: companyEmail('comprovante-fora'),
    name: 'Fora do Time',
    password: `Senha-${randomUUID()}`,
  });

  assert.equal((await get(href, outsider.cookie)).status, 404);
  assert.equal((await get(`/t/${fx.teamUrl}/documents/${fx.id}/envios`, outsider.cookie)).status, 404);

  // Comprovante de outro envelope pedido por este envelope.
  const second = await createEnvelope({
    title: `[TESTE] comprovante outro ${randomUUID().slice(0, 8)}`,
    meta: { distributionMethod: 'EMAIL' },
    recipients: [{ email: unique('comprovante-c'), name: 'Caio Comprovante' }],
  });

  assert.equal(second.status, 200, second.text);
  await distribute(second.id);

  const [otherRow] = await waitReceipts(second.id, 1);

  assert.ok(otherRow, 'o outro envelope precisa de um comprovante');
  assert.equal(
    (await get(`/t/${fx.teamUrl}/documents/${second.id}/comprovantes/${otherRow.data.receiptId}`, fx.cookie)).status,
    200,
  );
  assert.equal(
    (await get(`/t/${fx.teamUrl}/documents/${fx.id}/comprovantes/${otherRow.data.receiptId}`, fx.cookie)).status,
    404,
  );
  assert.equal((await get(`/t/${fx.teamUrl}/documents/${fx.id}/comprovantes/naoexiste`, fx.cookie)).status, 404);
});

test('situação: Enviado → Visualizado → Assinado; recusa = Recusado', { skip }, async () => {
  await waitReceipts(fx.id, 2);

  // Antes de abrir: só Enviado.
  let status = await sendStatus(fx.id, fx.cookie);

  assert.deepEqual(stepsOf(status, fx.signer.id), { SENT: true, VIEWED: false, SIGNED: false });
  assert.ok(status.receipts.length >= 2);
  assert.ok(status.receipts.every((receipt) => receipt.href.includes(`/documents/${fx.id}/comprovantes/`)));

  // Abre o link: a página de assinatura mostra o portão, e aceitar o termo é o primeiro passo dele = Visualizado.
  const page = await get(`/sign/${fx.signer.token}`);

  assert.ok(page.status < 500, `página de assinatura: ${page.status}`);
  await page.text();
  await gate(fx.signer.token);

  status = await sendStatus(fx.id, fx.cookie);
  assert.deepEqual(stepsOf(status, fx.signer.id), { SENT: true, VIEWED: true, SIGNED: false });

  const viewedStep = status.recipients
    .find((item) => item.recipientId === fx.signer.id)
    .steps.find((step) => step.key === 'VIEWED');

  assert.match(viewedStep.atLabel ?? '', /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);

  // Assina (o portão já passou).
  const field = fx.envelope.fields.find((item) => item.recipientId === fx.signer.id && item.type === 'SIGNATURE');

  await get(`/sign/${fx.signer.token}`).then((res) => res.text());
  await trpc('envelope.field.sign', {
    token: fx.signer.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Ana Comprovante' },
  });

  const completed = await completeWithCode({
    token: fx.signer.token,
    documentId: fx.documentId,
    email: fx.signerEmail,
  });

  assert.equal(completed.status, 200, completed.text);

  status = await sendStatus(fx.id, fx.cookie);
  assert.deepEqual(stepsOf(status, fx.signer.id), { SENT: true, VIEWED: true, SIGNED: true });

  const signedStep = status.recipients
    .find((item) => item.recipientId === fx.signer.id)
    .steps.find((step) => step.key === 'SIGNED');

  assert.match(signedStep.atLabel ?? '', /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);

  // O outro recusa.
  await gate(fx.other.token);

  const rejected = await trpc('recipient.rejectDocumentWithToken', {
    token: fx.other.token,
    documentId: fx.documentId,
    reason: 'Teste do comprovante',
  });

  assert.equal(rejected.status, 200, rejected.text);

  status = await sendStatus(fx.id, fx.cookie);

  const otherSteps = status.recipients.find((item) => item.recipientId === fx.other.id).steps;
  const rejectedStep = otherSteps.find((step) => step.key === 'REJECTED');

  assert.ok(rejectedStep?.reached, JSON.stringify(otherSteps));
  assert.equal(rejectedStep.label, 'Recusado');
  assert.ok(!otherSteps.some((step) => step.key === 'SIGNED'));
});

// Abrir o link já conta como Visualizado, mesmo parando no termo (a tela do portão grava a abertura, uma vez por
// destinatário). E-mail da empresa: só conta quando quem abre está logado na conta dele; o pedido sem sessão vai para
// Entrar/Criar conta e não é o destinatário (conta obrigatória, 16/11/2026).
test('GET da página de assinatura sozinho já conta como Visualizado', { skip }, async () => {
  const created = await createEnvelope({
    title: `[TESTE] comprovante aberto ${randomUUID().slice(0, 8)}`,
    meta: { distributionMethod: 'EMAIL' },
    recipients: [{ email: unique('comprovante-d'), name: 'Davi Comprovante' }],
  });

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);

  await waitReceipts(created.id, 1);
  assert.deepEqual(stepsOf(await sendStatus(created.id, fx.cookie), recipient.id), {
    SENT: true,
    VIEWED: false,
    SIGNED: false,
  });

  await get(`/sign/${recipient.token}`).then((res) => res.text());

  assert.deepEqual(stepsOf(await sendStatus(created.id, fx.cookie), recipient.id), {
    SENT: true,
    VIEWED: true,
    SIGNED: false,
  });

  // Abrir de novo não grava outra abertura.
  await get(`/sign/${recipient.token}`).then((res) => res.text());
  assert.equal(
    db(
      `select count(*) from "DocumentAuditLog" where "envelopeId" = '${created.id}' and type = 'DOCUMENT_OPENED' and data->>'recipientId' = '${recipient.id}'`,
    ),
    '1',
  );

  // E-mail da empresa: sem sessão o link redireciona e não conta; logado na conta dele, conta.
  const companyDoc = await createEnvelope({
    title: `[TESTE] comprovante aberto empresa ${randomUUID().slice(0, 8)}`,
    meta: { distributionMethod: 'EMAIL' },
    recipients: [{ email: companyEmail('comprovante-e'), name: 'Elisa Comprovante' }],
  });

  assert.equal(companyDoc.status, 200, companyDoc.text);

  const [companyRecipient] = await distribute(companyDoc.id);

  await waitReceipts(companyDoc.id, 1);

  const anonymous = await get(`/sign/${companyRecipient.token}`);

  assert.equal(anonymous.status, 302, 'sem sessão vai para Entrar/Criar conta');
  await anonymous.text();
  assert.equal(stepsOf(await sendStatus(companyDoc.id, fx.cookie), companyRecipient.id).VIEWED, false);

  const own = await get(`/sign/${companyRecipient.token}`, await sessionFor(companyRecipient.email));

  assert.equal(own.status, 200);
  await own.text();
  assert.equal(stepsOf(await sendStatus(companyDoc.id, fx.cookie), companyRecipient.id).VIEWED, true);
});
