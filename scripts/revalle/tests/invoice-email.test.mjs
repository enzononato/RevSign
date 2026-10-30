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
  assertNoPaidGeminiCalls,
  brasilia,
  completeWithCode,
  createEnvelope,
  db,
  distribute,
  downloadItem,
  drawingPng,
  fetchIdempotent,
  retryCreateOnStaleSocket,
  signIn,
  trpc,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const FAKE_URL = (process.env.REVSIGN_FAKE_GEMINI_URL ?? 'http://localhost:8787').replace(/\/$/, '');
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
let fakeUp = false;

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

// Na busca do Mailpit `Attachments` é um número; na mensagem completa, a lista de anexos.
const attachmentCount = (message) =>
  Array.isArray(message.Attachments) ? message.Attachments.length : Number(message.Attachments ?? 0);

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

// "NF escaneada": só uma imagem, nenhum texto (a detecção fica UNKNOWN). `variant` muda o arquivo.
const scannedPdf = async (variant) => {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(Buffer.from(drawingPng().split(',')[1], 'base64'));
  const page = doc.addPage([595, 842]);

  page.drawImage(png, { x: 40, y: 500, width: 500, height: 170 });
  doc.setTitle(`NF digitalizada ${variant} ${RUN}`);

  const file = path.join(tmp, `escaneada-${variant}.pdf`);

  writeFileSync(file, Buffer.from(await doc.save()));

  return file;
};

const fake = async (route, body) => {
  const res = await fetch(`${FAKE_URL}${route}`, body ? { method: 'POST', body: JSON.stringify(body) } : {});

  assert.equal(res.status, 200, `fake ${route}: ${res.status}`);

  return res.json();
};

// Pede a sugestão ao servidor falso (programado com `accountCode`, ou em erro quando for null) e espera terminar.
const settleSuggestion = async (envelopeId, accountCode) => {
  await fake('/__program', accountCode ? { mode: 'ok', accountCode } : { mode: 'error' });

  const classified = await trpcAs(userCookie, 'mutation', 'revalle.invoice.classify', { envelopeId });

  assert.equal(classified.status, 200, classified.text);

  for (let i = 0; i < 40; i += 1) {
    const state = await trpcAs(userCookie, 'query', 'revalle.invoice.get', { envelopeId });

    if (state.body.result.data.json.suggestionStatus !== 'PENDING') {
      return state.body.result.data.json;
    }

    await sleep(400);
  }

  throw new Error('a sugestão não terminou');
};

// Cria o documento, escolhe a conta (se `choice`), envia, passa pelo portão e conclui (ou recusa, com `reject`).
// `suggestion`: undefined = não pede sugestão; string = o servidor falso sugere essa conta; null = a sugestão falha.
const completeDocument = async ({ label, pdf, choice, meta, reject = false, suggestion }) => {
  const email = `nf-email-${label}-${RUN}@revalle.com.br`;
  const title = `[TESTE NF] email ${label} ${RUN}`;
  const created = await retryCreateOnStaleSocket(() => createEnvelope({ recipients: [{ email }], pdf, title, meta }));

  assert.equal(created.status, 200, created.text);

  if (suggestion !== undefined) {
    await settleSuggestion(created.id, suggestion);
  }

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

  if (reject) {
    const rejected = await trpc('recipient.rejectDocumentWithToken', {
      token: recipient.token,
      documentId,
      reason: 'Teste',
    });

    assert.equal(rejected.status, 200, rejected.text);
    assert.equal(await waitStatus(created.id, 'REJECTED'), 'REJECTED');

    return { id: created.id, title, email, item: created.envelope.envelopeItems[0] };
  }

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

// E-mails da contabilidade deste documento (o assunto leva o título único).
const accountingMails = async (doc) => (await emailsTo(ACCOUNTING)).filter((m) => m.Subject.includes(doc.title));

const waitAccountingMail = async (doc, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let found = [];

  do {
    found = await accountingMails(doc);

    if (found.length > 0) {
      return found;
    }

    await sleep(500);
  } while (Date.now() < deadline);

  return found;
};

const bodyOf = async (message) => (await readMessage(message.ID)).Text.replace(/\s+/g, ' ');

const completedAtOf = (id) =>
  new Date(`${db(`select "completedAt" from "Envelope" where id = '${id}'`).replace(' ', 'T')}Z`);

const ORIGIN_ACCEPTED = 'sugerida pela IA e aceita pelo remetente';
const ORIGIN_CHOSEN = 'escolhida pelo remetente';

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

  // O caminho da IA exige o servidor falso no ar E o app subido com ele (compose.test.yml): o container do servidor
  // falso pode continuar de pé com o app já recriado sem a chave.
  const aiStatus = (await trpcAs(adminCookie, 'query', 'revalle.invoice.adminGetSettings', undefined)).body?.result
    ?.data?.json?.aiStatus;

  fakeUp =
    aiStatus === 'CONFIGURED' &&
    (await fetch(`${FAKE_URL}/__health`)
      .then((res) => res.ok)
      .catch(() => false));
});

after(async () => {
  if (fakeUp) {
    await fake('/__reset', {});
  }

  if (adminCookie) {
    await settings(previousEmail);
  }
});

let doneId;
let doneSentAt;

sessionTest(
  'NF concluída com conta escolhida (sem sugestão): um e-mail, assunto exato, data, remetente e PDF selado',
  async () => {
    const doc = await completeDocument({
      label: 'conta',
      pdf: await danfe('conta'),
      choice: { code: '2.1.03' },
      suggestion: fakeUp ? null : undefined,
    });

    doneId = doc.id;

    const messages = await waitAccountingMail(doc);

    assert.equal(messages.length, 1, JSON.stringify(messages.map((m) => m.Subject)));

    const mail = await readMessage(messages[0].ID);

    assert.equal(mail.Subject, `Nota fiscal assinada: ${doc.title} · Conta 2.1.03 – Fornecedores`);
    assert.equal(mail.To[0].Address, ACCOUNTING);

    const text = mail.Text.replace(/\s+/g, ' ');

    assert.ok(text.includes(doc.title), text);
    assert.ok(text.includes(user.email), text);
    assert.ok(text.includes(`${brasilia(completedAtOf(doc.id))} (horário de Brasília)`), text);
    assert.ok(text.includes('2.1.03 – Fornecedores'), text);
    // Sem sugestão: nenhuma linha de origem.
    assert.equal(
      db(
        `select coalesce("acceptedSuggestion"::text, 'null') from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`,
      ),
      'null',
    );
    assert.ok(!text.includes(ORIGIN_ACCEPTED) && !text.includes(ORIGIN_CHOSEN), text);

    // Mesmos arquivos dos participantes: o PDF selado de cada item.
    assert.equal(attachmentCount(mail), 1, JSON.stringify(mail.Attachments));
    assert.equal(mail.Attachments[0].ContentType, 'application/pdf');

    const pdf = await readPart(messages[0].ID, mail.Attachments[0].PartID);

    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdf.equals(await downloadItem(doc.item.id, 'signed')), 'o anexo difere do PDF selado');
    assert.equal(sentAt(doc.id), 't');

    doneSentAt = db(
      `select "accountingEmailSentAt" from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`,
    );
  },
);

sessionTest('sugestão da IA aceita: o e-mail diz "sugerida pela IA e aceita pelo remetente"', async (t) => {
  if (!fakeUp) {
    t.skip('servidor falso do Gemini não está no ar');

    return;
  }

  const doc = await completeDocument({
    label: 'aceita',
    pdf: await danfe('aceita'),
    suggestion: '2.1.03',
    choice: { code: '2.1.03' },
  });

  assert.equal(
    db(`select "acceptedSuggestion" from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`),
    't',
  );

  const [message] = await waitAccountingMail(doc);
  const text = await bodyOf(message);

  assert.ok(text.includes(ORIGIN_ACCEPTED), text);
  assert.ok(!text.includes(ORIGIN_CHOSEN), text);
});

sessionTest('outra conta que não a sugerida: o e-mail diz "escolhida pelo remetente"', async (t) => {
  if (!fakeUp) {
    t.skip('servidor falso do Gemini não está no ar');

    return;
  }

  const doc = await completeDocument({
    label: 'outra',
    pdf: await danfe('outra'),
    suggestion: '2.1.03',
    choice: { code: '3.1.01' },
  });

  assert.equal(
    db(`select "acceptedSuggestion" from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`),
    'f',
  );

  const [message] = await waitAccountingMail(doc);
  const text = await bodyOf(message);

  assert.equal(message.Subject, `Nota fiscal assinada: ${doc.title} · Conta 3.1.01 – Serviços de terceiros`);
  assert.ok(text.includes(ORIGIN_CHOSEN), text);
  assert.ok(!text.includes(ORIGIN_ACCEPTED), text);
});

sessionTest('reselagem pelo admin não reenvia e não mexe em accountingEmailSentAt', async () => {
  assert.ok(doneId, 'depende do primeiro caso');

  const resealed = await trpcAs(adminCookie, 'mutation', 'admin.document.reseal', { id: doneId });

  assert.ok(resealed.ok, resealed.text);

  const itemData = () =>
    db(`select "documentDataId" from "EnvelopeItem" where "envelopeId" = '${doneId}' order by "order" limit 1`);
  const itemDataBefore = itemData();

  for (let i = 0; i < 60 && itemData() === itemDataBefore; i += 1) {
    await sleep(1000);
  }

  await sleep(4000);
  assert.equal((await emailsTo(ACCOUNTING)).filter((m) => m.Subject.includes(`email conta ${RUN}`)).length, 1);
  assert.equal(
    db(`select "accountingEmailSentAt" from "RevalleInvoiceClassification" where "envelopeId" = '${doneId}'`),
    doneSentAt,
  );
});

sessionTest('"Deixar para a contabilidade decidir": assunto e corpo com a definir pela contabilidade', async () => {
  const doc = await completeDocument({ label: 'defer', pdf: await danfe('defer'), choice: { defer: true } });
  const messages = await waitAccountingMail(doc);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].Subject, `Nota fiscal assinada: ${doc.title} · Conta: a definir pela contabilidade`);

  const text = await bodyOf(messages[0]);

  assert.ok(text.includes('Conta: a definir pela contabilidade'), text);
  assert.ok(!text.includes('Conta contábil:'), text);
  assert.ok(!text.includes(ORIGIN_ACCEPTED) && !text.includes(ORIGIN_CHOSEN), text);
});

sessionTest('e-mails dos participantes desligados: a contabilidade recebe mesmo assim, uma vez', async () => {
  const doc = await completeDocument({
    label: 'semparticipantes',
    pdf: await danfe('semparticipantes'),
    choice: { code: '2.1.03' },
    meta: { emailSettings: { documentCompleted: false, ownerDocumentCompleted: false } },
  });

  // Confere que o e-mail de conclusão dos participantes de fato não saiu (nenhum e-mail com anexo ao signatário).
  await sleep(3000);
  assert.equal((await emailsTo(doc.email)).filter((m) => attachmentCount(m) > 0).length, 0);

  const messages = await waitAccountingMail(doc);

  assert.equal(messages.length, 1, JSON.stringify(messages.map((m) => m.Subject)));
  await sleep(4000);
  assert.equal((await accountingMails(doc)).length, 1);
});

sessionTest('NF recusada: nenhum e-mail para a contabilidade', async () => {
  const doc = await completeDocument({
    label: 'recusada',
    pdf: await danfe('recusada'),
    choice: { defer: true },
    reject: true,
  });

  await sleep(6000);
  assert.equal((await accountingMails(doc)).length, 0);
  assert.equal(sentAt(doc.id), 'f');
});

sessionTest('sem e-mail da contabilidade configurado: nenhum e-mail', async () => {
  await settings('');

  try {
    const doc = await completeDocument({ label: 'sem', pdf: await danfe('sem'), choice: { defer: true } });

    await sleep(5000);
    assert.equal((await accountingMails(doc)).length, 0);
    assert.equal(sentAt(doc.id), 'f');
  } finally {
    await settings(ACCOUNTING);
  }
});

sessionTest('documento comum: nenhum e-mail para a contabilidade', async () => {
  const doc = await completeDocument({ label: 'comum', pdf: 'assets/example.pdf' });

  await sleep(5000);
  assert.equal((await accountingMails(doc)).length, 0);
  assert.equal(
    db(`select count(*) from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}' and "isInvoice" = 'YES'`),
    '0',
  );
});

sessionTest(
  'NF escaneada enviada sem resposta e concluída: o dono marca como NF, escolhe a conta e sai 1 e-mail (só 1)',
  async () => {
    const callsBefore = fakeUp ? (await fake('/__calls')).length : 0;
    // Sem resposta a "É nota fiscal?" (pela API, o servidor deixa enviar): segue como UNKNOWN, sem e-mail.
    const doc = await completeDocument({ label: 'escaneada', pdf: await scannedPdf('marcar') });

    assert.equal(
      db(`select "isInvoice" from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`),
      'UNKNOWN',
    );
    await sleep(4000);
    assert.equal((await accountingMails(doc)).length, 0);

    const marked = await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: doc.id });

    assert.equal(marked.status, 200, marked.text);
    assert.equal(marked.body.result.data.json.isInvoice, 'YES');
    assert.equal(marked.body.result.data.json.choice, null);

    // Marcado, mas ainda sem conta: nada sai.
    await sleep(3000);
    assert.equal((await accountingMails(doc)).length, 0);
    assert.equal(sentAt(doc.id), 'f');

    const chosen = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
      envelopeId: doc.id,
      choice: { code: '3.1.01' },
    });

    assert.equal(chosen.status, 200, chosen.text);

    const messages = await waitAccountingMail(doc);

    assert.equal(messages.length, 1, JSON.stringify(messages.map((m) => m.Subject)));
    assert.equal(messages[0].Subject, `Nota fiscal assinada: ${doc.title} · Conta 3.1.01 – Serviços de terceiros`);
    assert.equal(attachmentCount(await readMessage(messages[0].ID)), 1);
    assert.equal(sentAt(doc.id), 't');

    // Trocar a conta depois (dono e admin) e marcar de novo não reenviam.
    for (const [cookie, choice] of [
      [userCookie, { code: '2.1.03' }],
      [adminCookie, { defer: true }],
    ]) {
      const changed = await trpcAs(cookie, 'mutation', 'revalle.invoice.setChoice', { envelopeId: doc.id, choice });

      assert.equal(changed.status, 200, changed.text);
    }

    assert.equal(
      (await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: doc.id })).status,
      200,
    );
    await sleep(5000);
    assert.equal((await accountingMails(doc)).length, 1);

    // Nenhuma chamada à IA em todo o caminho (classificação congelada depois do envio).
    if (fakeUp) {
      assert.equal((await fake('/__calls')).length, callsBefore);
    }
  },
);
