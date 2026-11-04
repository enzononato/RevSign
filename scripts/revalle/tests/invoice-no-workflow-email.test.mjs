// Fase 7, Task 2: o fluxo da nota fiscal não manda e-mail de fluxo. Saíram o PDF para a contabilidade, o campo "E-mail
// da contabilidade" e o pedido "aguardando aprovação do Financeiro"; o Financeiro e a Contabilidade acham o que fazer na
// própria página (Notas fiscais). Os e-mails do upstream (convite, código, conclusão para quem assina) continuam.
//
// Conclui NFs de verdade (portão + código por e-mail + selagem) e confere o Mailpit e a fila de jobs: nenhum e-mail
// "Nota fiscal assinada" ou "Nota fiscal aguardando aprovação", nenhum job desses, a NF retida continua retida e a
// aprovação do Financeiro sela. Para o teste poder falhar no código antigo, o e-mail da contabilidade é "configurado" pela
// chave que a rota antiga aceitava (hoje ignorada).
//
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN) e REVSIGN_ADMIN_* (importa contas, aprova como Financeiro). O prompt
// anterior é restaurado no final. Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

import {
  assertNoPaidGeminiCalls,
  completeWithCode,
  createEnvelope,
  db,
  distribute,
  drawingPng,
  fetchIdempotent,
  retryCreateOnStaleSocket,
  signIn,
  trpc,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const MAILPIT = 'http://localhost:8025/api/v1';
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OLD_ACCOUNTING = `contabilidade-${RUN}@revalle.com.br`;
const CHAVE = '29241012345678000195550010000123451123456784';
const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
].join('\n');

// Os dois e-mails de fluxo que saíram (assunto antigo) e os jobs que os mandavam.
const WORKFLOW_SUBJECT = /^Nota fiscal (assinada|aguardando aprovação do Financeiro): /;
const WORKFLOW_JOBS = ['send.revalle.invoice.accounting.email', 'send.revalle.finance.approval.email'];

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-nf-sem-email-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userCookie;
let adminCookie;
let previousPrompt = '';

const data = (res) => res.body?.result?.data?.json;

const getSettings = async () => {
  const res = await trpcAs(adminCookie, 'query', 'revalle.invoice.adminGetSettings', undefined);

  assert.equal(res.status, 200, res.text);

  return data(res);
};

// Salva o prompt mandando também a chave antiga do e-mail da contabilidade: o servidor tem de ignorá-la.
const saveSettings = async (prompt, extra = {}) => {
  const res = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminUpdateSettings', { prompt, ...extra });

  assert.equal(res.status, 200, res.text);
};

const mailpit = (route) => fetchIdempotent(`${MAILPIT}${route}`, {}, (res) => res.json());

const mailsTo = async (to) => (await mailpit(`/search?query=${encodeURIComponent(`to:${to}`)}`)).messages ?? [];

const waitMail = async (to, filter, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;

  do {
    const found = (await mailsTo(to)).filter(filter);

    if (found.length > 0) {
      return found;
    }

    await sleep(500);
  } while (Date.now() < deadline);

  return [];
};

// Na busca do Mailpit `Attachments` é um número; na mensagem completa, a lista de anexos.
const attachmentCount = (message) =>
  Array.isArray(message.Attachments) ? message.Attachments.length : Number(message.Attachments ?? 0);

// A caixa guarda no máximo 500 mensagens: o retrato antes do caso e a diferença depois dão "o que este caso mandou".
const snapshot = async () => new Set(((await mailpit('/messages?limit=500')).messages ?? []).map((m) => m.ID));

const sentSince = async (before) =>
  ((await mailpit('/messages?limit=500')).messages ?? []).filter((m) => !before.has(m.ID));

const addresses = (message) => message.To.map((to) => to.Address);

const workflowJobsOf = (envelopeId) =>
  Number(
    db(
      `select count(*) from "BackgroundJob" where "jobId" in (${WORKFLOW_JOBS.map((job) => `'${job}'`).join(', ')}) and payload->>'envelopeId' = '${envelopeId}'`,
    ),
  );

const sealJobs = (documentId) =>
  db(
    `select status from "BackgroundJob" where "jobId" = 'internal.seal-document' and payload->>'documentId' = '${documentId}'`,
  )
    .split('\n')
    .filter(Boolean);

const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);

const financeStatus = (envelopeId) =>
  db(
    `select coalesce("financeStatus"::text, '-') from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );

const gate = async (token) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

// Fase 6: a NF retida (todos assinaram, aguardando o Financeiro) é aprovada pelo rsadmin, membro do Financeiro.
const approveAsFinance = async (envelopeId) => {
  const res = await trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', { envelopeId });

  assert.equal(res.status, 200, res.text);
  assert.deepEqual(data(res), { approved: true });
};

const waitStatus = async (envelopeId, wanted) => {
  for (let i = 0; i < 60 && status(envelopeId) !== wanted; i += 1) {
    await sleep(2000);
  }

  return status(envelopeId);
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
    `Referência do teste: sem e-mail de fluxo ${variant} ${RUN}`,
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

// Cria o documento, escolhe a conta (se `choice`), envia, passa pelo portão e assina com o código. A conclusão espera a
// aprovação do Financeiro numa NF (`approve: false` deixa a NF retida). Distribuição por e-mail: só assim o e-mail de
// conclusão do upstream chega a quem assina (a prova de que o envio de e-mail funciona neste caso).
const signDocument = async ({ label, pdf, choice, approve = true }) => {
  const email = `nf-sem-email-${label}-${RUN}@revalle.com.br`;
  const title = `[TESTE NF] sem e-mail ${label} ${RUN}`;
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({ recipients: [{ email }], pdf, title, meta: { distributionMethod: 'EMAIL' } }),
  );

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

  const doc = { id: created.id, documentId, title, email };

  if (approve && financeStatus(doc.id) === 'PENDING_APPROVAL') {
    await approveAsFinance(doc.id);
  }

  return doc;
};

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

  // O membro do Financeiro dos testes da Fase 6 é o rsadmin (fica marcado, como no finance-admin).
  const marked = await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', {
    userId: Number(db(`select id from "User" where email = '${admin.email}'`)),
    member: true,
  });

  assert.equal(marked.status, 200, marked.text);

  const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });

  assert.equal(imported.status, 200, imported.text);

  previousPrompt = (await getSettings()).prompt;
  // O código antigo mandava o PDF para este endereço; o novo ignora a chave (ver o caso 1).
  await saveSettings(previousPrompt, { accountingEmail: OLD_ACCOUNTING });
});

after(async () => {
  if (adminCookie) {
    await saveSettings(previousPrompt);
  }
});

sessionTest(
  'configurações: a chave "accountingEmail" é ignorada, não é devolvida e as colunas saíram do banco',
  async () => {
    const prompt = `Prefira contas a pagar. ${RUN}`;

    await saveSettings(prompt, { accountingEmail: 'x@revalle.com.br' });

    const settings = await getSettings();

    assert.equal(settings.prompt, prompt);
    assert.ok(!('accountingEmail' in settings), `a tela de admin ainda recebe a chave: ${JSON.stringify(settings)}`);
    assert.equal(
      db(
        `select count(*) from information_schema.columns where table_name = 'RevalleAccountingSettings' and column_name = 'accountingEmail'`,
      ),
      '0',
    );
    assert.equal(
      db(
        `select count(*) from information_schema.columns where table_name = 'RevalleInvoiceClassification' and column_name in ('accountingEmailSentAt', 'approvalRequestedAt')`,
      ),
      '0',
    );

    // Continua sendo uma rota só de admin com prompt limitado: o excesso é recusado.
    const tooLong = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminUpdateSettings', {
      prompt: 'x'.repeat(10_001),
    });

    assert.equal(tooLong.status, 400, tooLong.text);
    assert.equal((await getSettings()).prompt, prompt);

    await saveSettings(previousPrompt, { accountingEmail: OLD_ACCOUNTING });
  },
);

sessionTest(
  'NF concluída: nenhum e-mail de fluxo e nenhum anexo para ninguém além dos e-mails de conclusão',
  async () => {
    const before = await snapshot();
    const doc = await signDocument({ label: 'concluida', pdf: await danfe('concluida'), choice: { code: '2.1.03' } });

    assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');

    // O e-mail de conclusão do upstream chegou a quem assina: o envio de e-mail está de pé, então o silêncio abaixo vale.
    const completed = await waitMail(doc.email, (m) => attachmentCount(m) > 0);

    assert.equal(completed.length, 1, 'o e-mail de conclusão do upstream não chegou a quem assina');
    await sleep(6000);

    const sent = await sentSince(before);

    assert.deepEqual(
      sent.filter((m) => WORKFLOW_SUBJECT.test(m.Subject)).map((m) => m.Subject),
      [],
      'saiu e-mail de fluxo da NF',
    );
    assert.deepEqual(
      sent.filter((m) => addresses(m).includes(OLD_ACCOUNTING)).map((m) => m.Subject),
      [],
      'o endereço antigo da contabilidade recebeu e-mail',
    );

    // Anexo (o PDF selado) só no e-mail de conclusão do upstream, para quem assina e para o dono.
    const withAttachment = sent.filter((m) => attachmentCount(m) > 0);

    assert.ok(withAttachment.length > 0);

    for (const mail of withAttachment) {
      for (const to of addresses(mail)) {
        assert.ok([doc.email, user.email].includes(to), `${mail.Subject}: anexo para ${to}`);
      }
    }

    assert.equal(workflowJobsOf(doc.id), 0, 'um job de e-mail de fluxo foi disparado');
  },
);

sessionTest(
  'NF retida (todos assinaram, sem aprovação): ninguém do Financeiro é avisado por e-mail; a aprovação sela',
  async () => {
    const before = await snapshot();
    const doc = await signDocument({
      label: 'retida',
      pdf: await danfe('retida'),
      choice: { code: '2.1.03' },
      approve: false,
    });

    await sleep(6000);

    // Continua retida: pendente, sem aprovação, sem selagem, e conta como "aguardando a aprovação" na tela do admin.
    assert.equal(status(doc.id), 'PENDING');
    assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
    assert.deepEqual(sealJobs(doc.documentId), [], 'a conclusão da última assinatura disparou a selagem');

    const listed = await trpcAs(adminCookie, 'query', 'revalle.finance.adminListUsers', { query: admin.email });

    assert.equal(listed.status, 200, listed.text);
    assert.ok(data(listed).awaitingApprovalCount >= 1, `a NF retida não está na contagem: ${listed.text}`);

    // O membro do Financeiro não recebeu nada sobre esta NF.
    const sent = await sentSince(before);

    assert.deepEqual(
      sent.filter((m) => WORKFLOW_SUBJECT.test(m.Subject)).map((m) => `${m.Subject} -> ${addresses(m)}`),
      [],
      'saiu e-mail de fluxo',
    );
    assert.deepEqual(
      sent.filter((m) => addresses(m).includes(admin.email)).map((m) => m.Subject),
      [],
      'o membro do Financeiro recebeu e-mail',
    );
    assert.equal(workflowJobsOf(doc.id), 0, 'um job de e-mail de fluxo foi disparado');

    // Selar depois de aprovar continua funcionando: o documento conclui e quem assina recebe o PDF selado.
    await approveAsFinance(doc.id);
    assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');
    assert.equal((await waitMail(doc.email, (m) => attachmentCount(m) > 0)).length, 1);
    assert.equal(financeStatus(doc.id), 'APPROVED');
    assert.equal(workflowJobsOf(doc.id), 0);
    assert.deepEqual(
      (await sentSince(before)).filter((m) => WORKFLOW_SUBJECT.test(m.Subject)).map((m) => m.Subject),
      [],
    );
  },
);

sessionTest('NF escaneada concluída e marcada depois: a escolha da conta e a aprovação não mandam e-mail', async () => {
  const before = await snapshot();
  // Sem resposta a "É nota fiscal?" (pela API, o servidor deixa enviar): segue como UNKNOWN até o dono marcar.
  const doc = await signDocument({ label: 'escaneada', pdf: await scannedPdf('marcar') });

  assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');

  const marked = await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: doc.id });

  assert.equal(marked.status, 200, marked.text);
  assert.equal(data(marked).isInvoice, 'YES');

  const chosen = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
    envelopeId: doc.id,
    choice: { code: '3.1.01' },
  });

  assert.equal(chosen.status, 200, chosen.text);
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
  await approveAsFinance(doc.id);
  assert.equal(financeStatus(doc.id), 'APPROVED');

  // Marcar de novo também não manda nada.
  assert.equal(
    (await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: doc.id })).status,
    200,
  );
  await sleep(6000);

  assert.deepEqual(
    (await sentSince(before)).filter((m) => WORKFLOW_SUBJECT.test(m.Subject)).map((m) => m.Subject),
    [],
  );
  assert.equal(workflowJobsOf(doc.id), 0);
});
