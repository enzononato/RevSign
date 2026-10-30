// Fase 5, Task 5: e-mail para a contabilidade quando uma nota fiscal é concluída.
// Conclui NFs de verdade (portão + código por e-mail + selagem) e confere o Mailpit: assunto exato, PDF selado anexo,
// uma vez só (reselagem pelo admin não reenvia), nada sem e-mail configurado e nada para documento comum.
//
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN) e REVSIGN_ADMIN_* (importa contas, configura o e-mail da
// contabilidade e reseala). O e-mail anterior da contabilidade é restaurado no final. Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

import {
  completeWithCode,
  createEnvelope,
  db,
  distribute,
  downloadItem,
  fetchIdempotent,
  retryCreateOnStaleSocket,
  signIn,
  trpc,
  trpcAs,
} from './helpers.mjs';

const MAILPIT = 'http://localhost:8025/api/v1';
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ACCOUNTING = `contabilidade-${RUN}@revalle.com.br`;
const CHAVE = '29241012345678000195550010000123451123456784';
const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
].join('\n');

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-nf-email-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userCookie;
let adminCookie;
let previousEmail = '';

const settings = async (accountingEmail) => {
  const current = await trpcAs(adminCookie, 'query', 'revalle.invoice.adminGetSettings', undefined);

  assert.equal(current.status, 200, current.text);

  const res = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminUpdateSettings', {
    prompt: current.body.result.data.json.prompt,
    accountingEmail,
  });

  assert.equal(res.status, 200, res.text);
};

const emailsTo = async (to) =>
  (await fetchIdempotent(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`, {}, (res) => res.json()))
    .messages ?? [];

const waitMail = async (to, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;

  do {
    const messages = await emailsTo(to);

    if (messages.length > 0) {
      return messages;
    }

    await sleep(500);
  } while (Date.now() < deadline);

  return [];
};

const readMessage = (id) => fetchIdempotent(`${MAILPIT}/message/${id}`, {}, (res) => res.json());

const readPart = (id, partId) =>
  fetchIdempotent(`${MAILPIT}/message/${id}/part/${partId}`, {}, async (res) => Buffer.from(await res.arrayBuffer()));

const gate = async (token) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

const waitStatus = async (envelopeId, wanted) => {
  for (let i = 0; i < 60 && db(`select status from "Envelope" where id = '${envelopeId}'`) !== wanted; i += 1) {
    await sleep(2000);
  }

  return db(`select status from "Envelope" where id = '${envelopeId}'`);
};

const danfe = async (variant) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const lines = [
    'DANFE - Documento Auxiliar da Nota Fiscal Eletrônica',
    'Nº 000.012.345   Série 001',
    'Chave de Acesso',
    CHAVE.replace(/(\d{4})(?=\d)/g, '$1 '),
    'Natureza da Operação: Venda de mercadoria adquirida de terceiros',
    'Emitente: Distribuidora Fictícia de Ferragens Ltda   CNPJ 12.345.678/0001-95',
    `Referência do teste: e-mail ${variant} ${RUN}`,
    'Valor Total da Nota: R$ 150,00',
  ];
  let y = 800;

  for (const line of lines) {
    page.drawText(line, { x: 40, y, size: 10, font, color: rgb(0, 0, 0) });
    y -= 16;
  }

  const file = path.join(tmp, `danfe-${variant}.pdf`);

  writeFileSync(file, Buffer.from(await doc.save()));

  return file;
};

// Cria o documento, (opcionalmente) escolhe a conta, envia, passa pelo portão e conclui. Espera a selagem.
const completeDocument = async ({ label, pdf, choice }) => {
  const email = `nf-email-${label}-${RUN}@revalle.com.br`;
  const title = `[TESTE NF] email ${label} ${RUN}`;
  const created = await retryCreateOnStaleSocket(() => createEnvelope({ recipients: [{ email }], pdf, title }));

  assert.equal(created.status, 200, created.text);

  if (choice) {
    const res = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
      envelopeId: created.id,
      choice,
    });

    assert.equal(res.status, 200, res.text);
  }

  const [recipient] = await distribute(created.id);
  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const field = created.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');

  await gate(recipient.token);

  const signed = await trpc('envelope.field.sign', {
    token: recipient.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Teste Digitado' },
  });

  assert.equal(signed.status, 200, signed.text);

  const completion = await completeWithCode({ token: recipient.token, documentId, email });

  assert.ok(completion.ok, completion.text);
  assert.equal(await waitStatus(created.id, 'COMPLETED'), 'COMPLETED');

  return { id: created.id, title, email, item: created.envelope.envelopeItems[0] };
};

const sentAt = (envelopeId) =>
  db(
    `select "accountingEmailSentAt" is not null from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );

const sessionTest = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie || !adminCookie) {
      t.skip('credenciais de sessão não informadas');

      return;
    }

    await fn(t);
  });

before(async () => {
  if (!user.email || !user.password || !admin.email || !admin.password) {
    return;
  }

  userCookie = await signIn(user.email, user.password);
  adminCookie = await signIn(admin.email, admin.password);

  const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });

  assert.equal(imported.status, 200, imported.text);

  const current = await trpcAs(adminCookie, 'query', 'revalle.invoice.adminGetSettings', undefined);

  previousEmail = current.body.result.data.json.accountingEmail ?? '';
  await settings(ACCOUNTING);
});

after(async () => {
  if (adminCookie) {
    await settings(previousEmail);
  }
});

let doneId;

sessionTest(
  'NF concluída com conta escolhida: um e-mail para a contabilidade, assunto exato e PDF selado',
  async () => {
    const doc = await completeDocument({
      label: 'conta',
      pdf: await danfe('conta'),
      choice: { code: '2.1.03' },
    });

    doneId = doc.id;

    const messages = await waitMail(ACCOUNTING);

    assert.equal(messages.length, 1, JSON.stringify(messages.map((m) => m.Subject)));

    const mail = await readMessage(messages[0].ID);

    assert.equal(mail.Subject, `Nota fiscal assinada: ${doc.title} · Conta 2.1.03 – Fornecedores`);
    assert.equal(mail.To[0].Address, ACCOUNTING);

    const text = mail.Text.replace(/\s+/g, ' ');

    assert.ok(text.includes(doc.title), text);
    assert.ok(text.includes(user.email), text);
    assert.ok(text.includes('(horário de Brasília)'), text);
    assert.ok(text.includes('2.1.03'), text);

    // A linha da origem da escolha segue o que ficou gravado.
    const accepted = db(
      `select "acceptedSuggestion" from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`,
    );

    if (accepted === 't') {
      assert.ok(text.includes('sugerida pela IA e aceita pelo remetente'), text);
    } else if (accepted === 'f') {
      assert.ok(text.includes('escolhida pelo remetente'), text);
    } else {
      assert.ok(!text.includes('sugerida pela IA') && !text.includes('escolhida pelo remetente'), text);
    }

    // Mesmos arquivos dos participantes: o PDF selado de cada item.
    assert.equal(mail.Attachments.length, 1, JSON.stringify(mail.Attachments));
    assert.equal(mail.Attachments[0].ContentType, 'application/pdf');

    const pdf = await readPart(messages[0].ID, mail.Attachments[0].PartID);

    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');

    // É o PDF selado do documento (o mesmo arquivo dos e-mails de conclusão), não o original.
    const sealed = await downloadItem(doc.item.id, 'signed');

    assert.ok(pdf.equals(sealed), 'o anexo da contabilidade difere do PDF selado');
    assert.equal(sentAt(doc.id), 't');
  },
);

sessionTest('reselagem pelo admin não reenvia', async () => {
  assert.ok(doneId, 'depende do caso anterior');

  const resealed = await trpcAs(adminCookie, 'mutation', 'admin.document.reseal', { id: doneId });

  assert.ok(resealed.ok, resealed.text);

  const itemDataBefore = db(
    `select "documentDataId" from "EnvelopeItem" where "envelopeId" = '${doneId}' order by "order" limit 1`,
  );

  for (
    let i = 0;
    i < 60 &&
    db(`select "documentDataId" from "EnvelopeItem" where "envelopeId" = '${doneId}' order by "order" limit 1`) ===
      itemDataBefore;
    i += 1
  ) {
    await sleep(1000);
  }

  await sleep(4000);
  assert.equal((await emailsTo(ACCOUNTING)).length, 1);
});

sessionTest('"Deixar para a contabilidade decidir": assunto com a definir pela contabilidade', async () => {
  const doc = await completeDocument({ label: 'defer', pdf: await danfe('defer'), choice: { defer: true } });
  const messages = (await waitMail(ACCOUNTING, 30_000)).filter((m) => m.Subject.includes(doc.title));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].Subject, `Nota fiscal assinada: ${doc.title} · Conta: a definir pela contabilidade`);
});

sessionTest('sem e-mail da contabilidade configurado: nenhum e-mail', async () => {
  await settings('');

  try {
    const before = (await emailsTo(ACCOUNTING)).length;
    const doc = await completeDocument({ label: 'sem', pdf: await danfe('sem'), choice: { defer: true } });

    await sleep(5000);
    assert.equal((await emailsTo(ACCOUNTING)).length, before);
    assert.equal(sentAt(doc.id), 'f');
  } finally {
    await settings(ACCOUNTING);
  }
});

sessionTest('documento comum: nenhum e-mail para a contabilidade', async () => {
  const before = (await emailsTo(ACCOUNTING)).length;
  const doc = await completeDocument({ label: 'comum', pdf: 'assets/example.pdf' });

  await sleep(5000);
  assert.equal((await emailsTo(ACCOUNTING)).length, before);
  assert.equal(
    db(`select count(*) from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}' and "isInvoice" = 'YES'`),
    '0',
  );
});
