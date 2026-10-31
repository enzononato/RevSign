// Fase 6, Task 3: a selagem da nota fiscal espera a aprovação do Financeiro.
//   - NF `PENDING_APPROVAL` com 2 signatários: os dois assinam e o documento continua PENDING (nenhum job de selagem),
//     e os membros do Financeiro recebem UM e-mail "Nota fiscal aguardando aprovação do Financeiro: {título}";
//   - a varredura de selagem (`internal.seal-document-sweep`, disparada como o cron do app dispara: linha em
//     "BackgroundJob" + POST assinado em /api/jobs) não sela a NF retida, e sela uma NF `LEGACY` no mesmo estado;
//   - a reselagem pelo admin de uma NF retida chega ao job de selagem, que sai sem selar e sem falhar (defesa em
//     profundidade: qualquer caminho que dispare o job fica retido);
//   - `revalle.finance.approve`: 401 sem sessão, 403 fora do Financeiro, 400 numa NF aguardando a conta; pelo Financeiro
//     grava `APPROVED` e quem/quando, registra o evento (também no log em PDF), sela e a contabilidade recebe 1 e-mail;
//     a 2ª chamada devolve `{ approved: false }` sem nada a mais;
//   - aprovar antes de todos assinarem: o último a assinar sela direto;
//   - disparo duplicado numa NF já concluída não carimba de novo, mas o retry do MESMO job (falha depois de selar)
//     termina os passos seguintes (e-mail de conclusão); aprovação simultânea = 1 evento e 1 selagem;
//   - a varredura conta a aprovação como atividade: aprovada há 20 minutos (assinaturas há 7 horas) é selada, há 5
//     minutos ainda não; versão substituída (`SUPERSEDED`, no banco) nunca é selada e não pede aprovação;
//   - os outros dois pontos de disparo também retêm: o admin remove o último pendente, e a NF só com CC (o atalho de
//     selagem do envio) sai e fica PENDING; nos dois, a aprovação sela;
//   - NF `LEGACY` e documento comum concluem sem retenção; NF recusada fica REJECTED sem retenção.
//
// Sessões: REVSIGN_USER_* (admin@hml.local, dono do REVSIGN_API_TOKEN, fora do Financeiro) e REVSIGN_ADMIN_* (rsadmin,
// ADMIN, marcado como Financeiro aqui). O e-mail da contabilidade anterior é restaurado no final. Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

import {
  APP_CONTAINER,
  api,
  assertNoPaidGeminiCalls,
  BASE_URL,
  completeWithCode,
  createEnvelope,
  db,
  distribute,
  downloadItem,
  fetchIdempotent,
  poppler,
  retryCreateOnStaleSocket,
  signIn,
  trpc,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MAILPIT = 'http://localhost:8025/api/v1';
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const ACCOUNTING = `contabilidade-f6-${RUN}@revalle.com.br`;
const APPROVAL_SUBJECT = (title) => `Nota fiscal aguardando aprovação do Financeiro: ${title}`;

const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
].join('\n');

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-financeiro-aprovacao-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userCookie;
let adminCookie;
let adminId;
let previousEmail = '';

const data = (res) => res.body?.result?.data?.json;
const approve = (envelopeId, cookie = adminCookie) =>
  trpcAs(cookie, 'mutation', 'revalle.finance.approve', { envelopeId });
const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);
const financeStatus = (envelopeId) =>
  db(
    `select coalesce("financeStatus"::text, '-') from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );
const auditCount = (envelopeId, type) =>
  Number(db(`select count(*) from "DocumentAuditLog" where "envelopeId" = '${envelopeId}' and type = '${type}'`));
// Jobs de selagem deste documento (o payload leva o id legado do documento).
const sealJobs = (doc) =>
  db(
    `select status from "BackgroundJob" where "jobId" = 'internal.seal-document' and payload->>'documentId' = '${doc.documentId}' order by "submittedAt"`,
  )
    .split('\n')
    .filter(Boolean);
const itemData = (envelopeId) =>
  db(`select "documentDataId" from "EnvelopeItem" where "envelopeId" = '${envelopeId}' order by "order" limit 1`);

// Hash do PDF selado atual e quantas selagens o histórico tem (um carimbo a mais muda os dois).
const sealedHash = (itemId) =>
  db(
    `select h."finalSha256" || '|' || (select count(*) from "RevalleSealedHash" s where s."documentHashId" = h.id) from "RevalleDocumentHash" h where h."envelopeItemId" = '${itemId}'`,
  );

const mailsTo = async (to) =>
  (await fetchIdempotent(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`, {}, (res) => res.json()))
    .messages ?? [];

const waitMails = async (to, filter, timeoutMs = 30_000) => {
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

const approvalMails = async (doc) =>
  (await mailsTo(admin.email)).filter((m) => m.Subject === APPROVAL_SUBJECT(doc.title));
const accountingMails = async (doc) => (await mailsTo(ACCOUNTING)).filter((m) => m.Subject.includes(doc.title));

const waitStatus = async (envelopeId, wanted, attempts = 45) => {
  for (let i = 0; i < attempts && status(envelopeId) !== wanted; i += 1) {
    await sleep(2000);
  }

  return status(envelopeId);
};

const settings = async (accountingEmail) => {
  const current = await trpcAs(adminCookie, 'query', 'revalle.invoice.adminGetSettings', undefined);

  assert.equal(current.status, 200, current.text);

  const res = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminUpdateSettings', {
    prompt: data(current).prompt,
    accountingEmail,
  });

  assert.equal(res.status, 200, res.text);

  return data(current).accountingEmail ?? '';
};

// DANFE fictício; `variant` muda o arquivo (outra SHA-256, sem cache da sugestão).
const danfe = async (variant) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const lines = [
    'DANFE - Documento Auxiliar da Nota Fiscal Eletrônica',
    'Nº 000.012.345   Série 001',
    'Chave de Acesso',
    '2924 1012 3456 7800 0195 5500 1000 0123 4511 2345 6784',
    'Natureza da Operação: Venda de mercadoria adquirida de terceiros',
    'Emitente: Distribuidora Fictícia de Ferragens Ltda   CNPJ 12.345.678/0001-95',
    `Referência do teste: financeiro aprovação ${variant} ${RUN}`,
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

// Cria (NF com a conta `code`, ou documento comum com `pdf`), envia pela API v2 e devolve os destinatários com token.
// `choice: null` = documento comum, sem escolha.
const sendDocument = async (label, { signers = 2, choice = { code: '2.1.03' }, pdf, meta } = {}) => {
  const emails = Array.from({ length: signers }, (_, index) => `f6-aprova-${label}-${index + 1}-${RUN}@revalle.com.br`);
  const title = `[TESTE NF] financeiro aprovação ${label} ${RUN}`;
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({
      recipients: emails.map((email) => ({ email })),
      pdf: pdf ?? 'assets/example.pdf',
      title,
      meta,
    }),
  );

  assert.equal(created.status, 200, created.text);

  if (choice) {
    const chosen = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
      envelopeId: created.id,
      choice,
    });

    assert.equal(chosen.status, 200, chosen.text);
  }

  const recipients = await distribute(created.id);

  assert.equal(recipients.length, signers);

  return {
    id: created.id,
    title,
    documentId: Number.parseInt(created.envelope.secondaryId.split('_')[1], 10),
    fields: created.envelope.fields,
    item: created.envelope.envelopeItems[0],
    recipients,
  };
};

const newInvoice = async (label, options = {}) => await sendDocument(label, { ...options, pdf: await danfe(label) });

const gate = async (token) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

// Portão (termo, CPF + data de nascimento da Maria fictícia, "sou eu"), assinatura e conclusão com o código.
const sign = async (doc, index) => {
  const recipient = doc.recipients[index];
  const field = doc.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');

  await gate(recipient.token);

  const signed = await trpc('envelope.field.sign', {
    token: recipient.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Teste Digitado' },
  });

  assert.equal(signed.status, 200, signed.text);

  const completion = await completeWithCode({
    token: recipient.token,
    documentId: doc.documentId,
    email: recipient.email,
  });

  assert.ok(completion.ok, completion.text);
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
};

// Roda um job como o app roda (o cron do provedor local faz exatamente isto): grava a linha PENDING em
// "BackgroundJob" e faz o POST em /api/jobs/{job}/{id} com a assinatura do app. A assinatura é calculada DENTRO do
// container (a chave não sai de lá; só a assinatura volta). Devolve o status final da linha.
// `retryOf`: repete um job que já existe, como o provedor faz depois de uma falha (a linha volta a PENDING e o POST
// leva `X-Job-Retry`); as tarefas já concluídas do job devolvem o resultado guardado.
const runJobLikeTheApp = async ({ jobId, name, version, payload, retryOf }) => {
  const options = { name: jobId, payload };
  const script = `
    const crypto = require('node:crypto');
    const { xchacha20poly1305 } = require('@noble/ciphers/chacha');
    const { managedNonce } = require('@noble/ciphers/webcrypto');
    const { bytesToHex, utf8ToBytes } = require('@noble/ciphers/utils');
    const { sha256 } = require('@noble/hashes/sha2');
    const hashed = crypto.createHash('sha512').update(process.argv[1]).digest('hex');
    const key = sha256(process.env.NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY);
    const sealed = managedNonce(xchacha20poly1305)(key).encrypt(utf8ToBytes(JSON.stringify({ data: hashed })));
    process.stdout.write(bytesToHex(sealed));
  `;
  const signature = execFileSync('docker', ['exec', APP_CONTAINER, 'node', '-e', script, JSON.stringify(options)], {
    encoding: 'utf8',
  }).trim();
  const id = retryOf ?? `revsign-test-${jobId}-${RUN}-${Date.now()}`;

  if (retryOf) {
    db(`update "BackgroundJob" set status = 'PENDING' where id = '${retryOf}'`);
  } else {
    db(
      `insert into "BackgroundJob" (id, "jobId", name, version, payload, "updatedAt") values ('${id}', '${jobId}', '${name}', '${version}', '${JSON.stringify(payload)}', now())`,
    );
  }

  const res = await fetch(`${BASE_URL}/api/jobs/${jobId}/${id}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Job-Id': id,
      'X-Job-Signature': signature,
      ...(retryOf ? { 'X-Job-Retry': '1' } : {}),
    },
    body: JSON.stringify(options),
  });

  assert.equal(res.status, 200, `job ${jobId}: HTTP ${res.status} ${await res.text()}`);

  return db(`select status from "BackgroundJob" where id = '${id}'`);
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
  adminId = Number(db(`select id from "User" where email = '${admin.email}'`));

  // O membro do Financeiro dos testes da Fase 6 é o rsadmin; o usuário comum nunca é.
  const marked = await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', {
    userId: adminId,
    member: true,
  });

  assert.equal(marked.status, 200, marked.text);
  db(`delete from "RevalleFinanceMember" where "userId" = (select id from "User" where email = '${user.email}')`);

  const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });

  assert.equal(imported.status, 200, imported.text);
  db(`delete from "RateLimit" where action like 'revalle.invoice%'`);

  previousEmail = await settings(ACCOUNTING);
});

after(async () => {
  if (adminCookie) {
    await settings(previousEmail);
  }
});

let held;

sessionTest(
  'NF aguardando aprovação: os 2 assinam, o documento continua PENDING (sem selagem) e o Financeiro recebe 1 e-mail',
  async () => {
    held = await newInvoice('retida');

    assert.equal(financeStatus(held.id), 'PENDING_APPROVAL');

    await sign(held, 0);
    await sign(held, 1);

    const mails = await waitMails(admin.email, (m) => m.Subject === APPROVAL_SUBJECT(held.title));

    assert.equal(mails.length, 1, 'o e-mail de aprovação ao Financeiro não chegou (ou chegou mais de um)');

    const body = await fetchIdempotent(`${MAILPIT}/message/${mails[0].ID}`, {}, (res) => res.json());

    assert.ok(body.Text.includes(held.title), body.Text);
    assert.ok(body.Text.includes('/notas-fiscais'), body.Text);

    await sleep(4000);
    assert.equal(status(held.id), 'PENDING');
    assert.equal(financeStatus(held.id), 'PENDING_APPROVAL');
    assert.deepEqual(sealJobs(held), [], 'a conclusão do último signatário disparou a selagem');
    assert.equal(auditCount(held.id, 'DOCUMENT_COMPLETED'), 0);
    assert.equal(
      db(
        `select "approvalRequestedAt" is not null from "RevalleInvoiceClassification" where "envelopeId" = '${held.id}'`,
      ),
      't',
    );
    assert.equal((await accountingMails(held)).length, 0);
  },
);

sessionTest(
  'varredura de selagem (como o cron do app dispara): não sela a NF retida e sela uma NF LEGACY no mesmo estado',
  async () => {
    assert.ok(held, 'depende do primeiro caso');

    // Controle: outra NF retida (todos assinaram) que vira LEGACY no banco. A varredura tem de selar esta; senão ela
    // nem rodou e o caso não provaria nada.
    const control = await newInvoice('varredura-legacy');

    await sign(control, 0);
    await sign(control, 1);
    await sleep(2000);
    assert.equal(status(control.id), 'PENDING');
    db(`update "RevalleInvoiceClassification" set "financeStatus" = 'LEGACY' where "envelopeId" = '${control.id}'`);

    // A varredura só pega o que foi assinado entre 15 minutos e 6 horas atrás.
    db(
      `update "Recipient" set "signedAt" = now() - interval '20 minutes' where "envelopeId" in ('${held.id}', '${control.id}')`,
    );

    const swept = await runJobLikeTheApp({
      jobId: 'internal.seal-document-sweep',
      name: 'Seal Document Sweep',
      version: '1.0.0',
      payload: {},
    });

    assert.equal(swept, 'COMPLETED');
    assert.equal(await waitStatus(control.id, 'COMPLETED'), 'COMPLETED', 'a varredura não selou a NF LEGACY');
    assert.equal(sealJobs(control).length, 1);

    assert.equal(status(held.id), 'PENDING');
    assert.deepEqual(sealJobs(held), [], 'a varredura disparou a selagem da NF retida');
    assert.equal((await approvalMails(held)).length, 1, 'o e-mail de aprovação saiu de novo');
  },
);

sessionTest(
  'reselagem pelo admin de uma NF retida: o job de selagem termina sem selar e sem falhar (defesa em profundidade)',
  async () => {
    assert.ok(held, 'depende do primeiro caso');

    const before = itemData(held.id);
    const resealed = await trpcAs(adminCookie, 'mutation', 'admin.document.reseal', { id: held.id });

    assert.ok(resealed.ok, resealed.text);

    for (let i = 0; i < 30 && sealJobs(held).at(-1) !== 'COMPLETED'; i += 1) {
      await sleep(1000);
    }

    assert.deepEqual(sealJobs(held), ['COMPLETED'], 'o job de selagem falhou ou não rodou');
    assert.equal(status(held.id), 'PENDING');
    assert.equal(itemData(held.id), before, 'o PDF foi selado');
    assert.equal(auditCount(held.id, 'DOCUMENT_COMPLETED'), 0);
    assert.equal((await approvalMails(held)).length, 1);
  },
);

sessionTest('approve: 401 sem sessão, 403 fora do Financeiro e 400 numa NF aguardando a conta', async () => {
  assert.ok(held, 'depende do primeiro caso');

  const anonymous = await trpc('revalle.finance.approve', { envelopeId: held.id });

  assert.equal(anonymous.status, 401, anonymous.text);

  const outsider = await approve(held.id, userCookie);

  assert.equal(outsider.status, 403, outsider.text);
  assert.equal(financeStatus(held.id), 'PENDING_APPROVAL');
  assert.equal(auditCount(held.id, 'REVALLE_FINANCE_APPROVED'), 0);

  // "Deixar para o Financeiro": a conta é definida (defineAccount), não aprovada.
  const pdf = await danfe('deixar');
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({
      recipients: [{ email: `f6-aprova-deixar-${RUN}@revalle.com.br` }],
      pdf,
      title: `[TESTE NF] financeiro aprovação deixar ${RUN}`,
    }),
  );

  assert.equal(created.status, 200, created.text);
  assert.equal(
    (
      await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
        envelopeId: created.id,
        choice: { defer: true },
      })
    ).status,
    200,
  );

  const sent = await api('POST', '/envelope/distribute', { envelopeId: created.id });

  assert.equal(sent.status, 409, sent.text);
  assert.equal(financeStatus(created.id), 'AWAITING_ACCOUNT');

  const notPending = await approve(created.id);

  assert.equal(notPending.status, 400, notPending.text);
  assert.equal(financeStatus(created.id), 'AWAITING_ACCOUNT');
  assert.equal(status(created.id), 'DRAFT');
});

sessionTest(
  'approve pelo Financeiro: APPROVED, evento no log (também no PDF), selada, 1 e-mail à contabilidade; 2ª chamada não faz nada',
  async () => {
    assert.ok(held, 'depende do primeiro caso');

    const res = await approve(held.id);

    assert.equal(res.status, 200, res.text);
    assert.deepEqual(data(res), { approved: true });
    assert.equal(financeStatus(held.id), 'APPROVED');
    assert.equal(
      db(
        `select "approvedById" || '|' || ("approvedAt" is not null) from "RevalleInvoiceClassification" where "envelopeId" = '${held.id}'`,
      ),
      `${adminId}|true`,
    );
    assert.equal(auditCount(held.id, 'REVALLE_FINANCE_APPROVED'), 1);
    assert.equal(await waitStatus(held.id, 'COMPLETED'), 'COMPLETED');

    const mails = await waitMails(ACCOUNTING, (m) => m.Subject.includes(held.title));

    assert.equal(mails.length, 1);
    assert.equal(mails[0].Subject, `Nota fiscal assinada: ${held.title} · Conta 2.1.03 – Fornecedores`);

    // A aprovação fica no log de auditoria anexado ao PDF selado.
    const dir = mkdtempSync(path.join(tmp, 'selado-'));

    writeFileSync(path.join(dir, 'signed.pdf'), await downloadItem(held.item.id, 'signed'));

    const text = poppler(dir, 'pdftotext /pdf/signed.pdf -').replace(/\s+/g, ' ');

    assert.ok(text.includes('Conta contábil aprovada pelo Financeiro'), 'a aprovação não está no log do PDF selado');

    // Repetição (ou clique duplo): nada muda.
    const again = await approve(held.id);

    assert.equal(again.status, 200, again.text);
    assert.deepEqual(data(again), { approved: false });
    assert.equal(auditCount(held.id, 'REVALLE_FINANCE_APPROVED'), 1);
    await sleep(4000);
    assert.equal((await accountingMails(held)).length, 1);
    assert.equal(auditCount(held.id, 'DOCUMENT_COMPLETED'), 1);
  },
);

sessionTest('disparo duplicado da selagem numa NF já concluída: nada é carimbado de novo', async () => {
  assert.ok(held, 'depende do primeiro caso');
  assert.equal(status(held.id), 'COMPLETED');

  const before = [itemData(held.id), sealedHash(held.item.id)];
  // O mesmo job que a aprovação e a última assinatura disparam (sem `isResealing`), pelo mecanismo do app.
  const job = await runJobLikeTheApp({
    jobId: 'internal.seal-document',
    name: 'Seal Document',
    version: '1.0.0',
    payload: { documentId: held.documentId },
  });

  assert.equal(job, 'COMPLETED');
  assert.deepEqual([itemData(held.id), sealedHash(held.item.id)], before, 'o PDF selado mudou');
  assert.equal(auditCount(held.id, 'DOCUMENT_COMPLETED'), 1);
});

sessionTest(
  'retry do mesmo job de selagem (falha depois de selar): termina os passos seguintes e o e-mail de conclusão sai',
  async () => {
    // Com distribuição por e-mail: só assim o e-mail de conclusão aos participantes sai.
    const doc = await sendDocument('retry', { signers: 1, choice: null, meta: { distributionMethod: 'EMAIL' } });
    const signer = doc.recipients[0].email;
    const completedMails = async () =>
      (await mailsTo(signer)).filter((m) => (Array.isArray(m.Attachments) ? m.Attachments.length : m.Attachments) > 0)
        .length;

    await sign(doc, 0);
    assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');
    assert.equal((await waitMails(signer, (m) => m.Attachments > 0)).length, 1, 'o e-mail de conclusão não chegou');

    // O job que selou: a tarefa `seal-document` dele está concluída, com o resultado guardado.
    const [jobId] = db(
      `select j.id from "BackgroundJob" j where j."jobId" = 'internal.seal-document' and j.payload->>'documentId' = '${doc.documentId}' and exists (select 1 from "BackgroundJobTask" t where t."jobId" = j.id and t.status = 'COMPLETED')`,
    ).split('\n');

    assert.ok(jobId, 'job de selagem não encontrado');

    const before = [itemData(doc.id), sealedHash(doc.item.id)];
    const payload = JSON.parse(db(`select payload::text from "BackgroundJob" where id = '${jobId}'`));
    // Um passo depois da selagem (webhook, e-mails) falhou: o provedor repete o MESMO job.
    const retried = await runJobLikeTheApp({ jobId: 'internal.seal-document', payload, retryOf: jobId });

    assert.equal(retried, 'COMPLETED');

    const deadline = Date.now() + 30_000;

    while ((await completedMails()) < 2 && Date.now() < deadline) {
      await sleep(500);
    }

    assert.equal(await completedMails(), 2, 'o retry não terminou os passos seguintes (e-mail de conclusão)');
    assert.deepEqual([itemData(doc.id), sealedHash(doc.item.id)], before, 'o retry selou de novo');
    assert.equal(auditCount(doc.id, 'DOCUMENT_COMPLETED'), 1);
  },
);

sessionTest('aprovação simultânea (clique duplo): 1 evento, 1 selagem', async () => {
  const doc = await newInvoice('simultanea');

  await sign(doc, 0);
  await sign(doc, 1);
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');

  const results = await Promise.all([approve(doc.id), approve(doc.id)]);

  for (const res of results) {
    assert.equal(res.status, 200, res.text);
  }

  assert.deepEqual(results.map((res) => data(res).approved).sort(), [false, true]);
  assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');
  await sleep(3000);
  assert.equal(auditCount(doc.id, 'REVALLE_FINANCE_APPROVED'), 1);
  assert.equal(auditCount(doc.id, 'DOCUMENT_COMPLETED'), 1);
  assert.equal(sealJobs(doc).length, 1);
});

sessionTest(
  'varredura e aprovação: aprovada há 20 minutos (assinada há 7 horas) é selada; aprovada há 5 minutos, ainda não',
  async () => {
    // Estado de uma aprovação cuja selagem se perdeu: todos assinaram, APPROVED, ainda PENDING.
    const lost = await newInvoice('varredura-aprovada-20');
    const recent = await newInvoice('varredura-aprovada-5');

    for (const doc of [lost, recent]) {
      await sign(doc, 0);
      await sign(doc, 1);
    }

    await sleep(2000);

    for (const [doc, minutes] of [
      [lost, 20],
      [recent, 5],
    ]) {
      assert.equal(status(doc.id), 'PENDING');
      db(
        `update "RevalleInvoiceClassification" set "financeStatus" = 'APPROVED', "approvedById" = ${adminId}, "approvedAt" = now() - interval '${minutes} minutes' where "envelopeId" = '${doc.id}'`,
      );
      // Fora da janela de 6 horas das assinaturas: só a aprovação recente põe o documento na varredura.
      db(`update "Recipient" set "signedAt" = now() - interval '7 hours' where "envelopeId" = '${doc.id}'`);
    }

    const swept = await runJobLikeTheApp({
      jobId: 'internal.seal-document-sweep',
      name: 'Seal Document Sweep',
      version: '1.0.0',
      payload: {},
    });

    assert.equal(swept, 'COMPLETED');
    assert.equal(await waitStatus(lost.id, 'COMPLETED'), 'COMPLETED', 'a varredura não recuperou a NF aprovada');
    assert.equal(sealJobs(lost).length, 1);
    assert.equal(status(recent.id), 'PENDING');
    assert.deepEqual(sealJobs(recent), [], 'a varredura correu com a selagem da aprovação recente');
  },
);

sessionTest(
  'versão substituída (SUPERSEDED) não concluída: nunca é selada (varredura e reselagem) e não pede aprovação',
  async () => {
    const doc = await newInvoice('substituida');

    // Desde a Task 4 o portão recusa qualquer ação de quem assina numa versão substituída: os dois assinam antes (NF
    // retida, 1 pedido de aprovação) e ela vira SUPERSEDED no banco depois. A troca de verdade, com a última assinatura
    // recusada, está em finance-change.test.mjs.
    await sign(doc, 0);
    await sign(doc, 1);
    await sleep(3000);
    assert.equal(status(doc.id), 'PENDING');
    assert.deepEqual(sealJobs(doc), [], 'a conclusão disparou a selagem da NF retida');
    assert.equal((await waitMails(admin.email, (m) => m.Subject === APPROVAL_SUBJECT(doc.title))).length, 1);

    db(
      `update "RevalleInvoiceClassification" set "financeStatus" = 'SUPERSEDED', "approvalRequestedAt" = null where "envelopeId" = '${doc.id}'`,
    );
    db(`update "Recipient" set "signedAt" = now() - interval '20 minutes' where "envelopeId" = '${doc.id}'`);

    const swept = await runJobLikeTheApp({
      jobId: 'internal.seal-document-sweep',
      name: 'Seal Document Sweep',
      version: '1.0.0',
      payload: {},
    });

    assert.equal(swept, 'COMPLETED');
    await sleep(2000);
    assert.deepEqual(sealJobs(doc), [], 'a varredura disparou a selagem');

    const before = itemData(doc.id);
    const resealed = await trpcAs(adminCookie, 'mutation', 'admin.document.reseal', { id: doc.id });

    assert.ok(resealed.ok, resealed.text);

    for (let i = 0; i < 30 && sealJobs(doc).at(-1) !== 'COMPLETED'; i += 1) {
      await sleep(1000);
    }

    assert.deepEqual(sealJobs(doc), ['COMPLETED'], 'o job de selagem falhou ou não rodou');
    assert.equal(status(doc.id), 'PENDING');
    assert.equal(itemData(doc.id), before, 'o PDF foi selado');
    assert.equal(auditCount(doc.id, 'DOCUMENT_COMPLETED'), 0);
    assert.equal((await approvalMails(doc)).length, 1, 'versão substituída pediu aprovação');
    assert.equal(
      db(`select "approvalRequestedAt" is null from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`),
      't',
    );
  },
);

sessionTest('aprovar antes de todos assinarem: quando o último assina, o documento é selado direto', async () => {
  const doc = await newInvoice('antes');

  await sign(doc, 0);

  const res = await approve(doc.id);

  assert.equal(res.status, 200, res.text);
  assert.deepEqual(data(res), { approved: true });
  await sleep(3000);
  assert.equal(status(doc.id), 'PENDING');
  assert.deepEqual(sealJobs(doc), [], 'selou com um signatário faltando');

  await sign(doc, 1);
  assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');
  assert.equal((await waitMails(ACCOUNTING, (m) => m.Subject.includes(doc.title))).length, 1);
  assert.equal((await approvalMails(doc)).length, 0, 'NF já aprovada não pede aprovação');
});

sessionTest(
  'remoção do último pendente pelo admin e envio sem destinatário atuante: NF retida até a aprovação',
  async () => {
    // Admin remove o único que faltava assinar: o upstream selaria na hora.
    const removed = await newInvoice('remocao');

    await sign(removed, 0);

    const deleted = await trpcAs(adminCookie, 'mutation', 'admin.recipient.delete', {
      id: removed.recipients[1].id,
      reason: 'Teste da retenção do Financeiro',
    });

    assert.equal(deleted.status, 200, deleted.text);

    // Só CC: o upstream selaria no próprio envio (atalho do `sendDocument`). Retida, a NF sai e fica PENDING.
    const pdf = await danfe('so-cc');
    const created = await retryCreateOnStaleSocket(() =>
      createEnvelope({
        recipients: [{ email: `f6-aprova-so-cc-${RUN}@revalle.com.br`, role: 'CC', fields: [] }],
        pdf,
        title: `[TESTE NF] financeiro aprovação so-cc ${RUN}`,
      }),
    );

    assert.equal(created.status, 200, created.text);
    assert.equal(
      (
        await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
          envelopeId: created.id,
          choice: { code: '2.1.03' },
        })
      ).status,
      200,
    );

    const ccOnly = {
      id: created.id,
      title: `[TESTE NF] financeiro aprovação so-cc ${RUN}`,
      documentId: Number.parseInt(created.envelope.secondaryId.split('_')[1], 10),
    };
    const sent = await api('POST', '/envelope/distribute', { envelopeId: ccOnly.id });

    assert.equal(sent.status, 200, sent.text);

    for (const doc of [removed, ccOnly]) {
      assert.equal(
        (await waitMails(admin.email, (m) => m.Subject === APPROVAL_SUBJECT(doc.title))).length,
        1,
        `${doc.title}: o e-mail de aprovação não chegou`,
      );
      await sleep(2000);
      assert.equal(status(doc.id), 'PENDING', doc.title);
      assert.deepEqual(sealJobs(doc), [], `${doc.title}: selagem disparada`);
    }

    for (const doc of [removed, ccOnly]) {
      const res = await approve(doc.id);

      assert.equal(res.status, 200, res.text);
      assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED', doc.title);
    }
  },
);

sessionTest('NF LEGACY e documento comum concluem sem retenção', async () => {
  const legacy = await newInvoice('legacy', { signers: 1 });

  db(`update "RevalleInvoiceClassification" set "financeStatus" = 'LEGACY' where "envelopeId" = '${legacy.id}'`);

  const common = await sendDocument('comum', { signers: 1, choice: null });

  await sign(legacy, 0);
  await sign(common, 0);

  assert.equal(await waitStatus(legacy.id, 'COMPLETED'), 'COMPLETED');
  assert.equal(await waitStatus(common.id, 'COMPLETED'), 'COMPLETED');
  assert.equal((await waitMails(ACCOUNTING, (m) => m.Subject.includes(legacy.title))).length, 1);
  assert.equal((await approvalMails(legacy)).length, 0);
  assert.ok(['', '-'].includes(financeStatus(common.id)), financeStatus(common.id));
  assert.equal((await accountingMails(common)).length, 0);
});

sessionTest('um signatário recusa: o documento fica REJECTED sem retenção', async () => {
  const doc = await newInvoice('recusa');

  await gate(doc.recipients[0].token);

  const rejected = await trpc('recipient.rejectDocumentWithToken', {
    token: doc.recipients[0].token,
    documentId: doc.documentId,
    reason: 'Teste',
  });

  assert.equal(rejected.status, 200, rejected.text);
  assert.equal(await waitStatus(doc.id, 'REJECTED'), 'REJECTED');
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
  assert.equal((await approvalMails(doc)).length, 0);
  assert.equal((await accountingMails(doc)).length, 0);
});

sessionTest('versão substituída com recusa: é selada como recusada (a recusa vale também para ela)', async () => {
  const doc = await newInvoice('substituida-recusa', { signers: 1 });

  // Desde a Task 4 o portão recusa a recusa numa versão substituída, e a troca recusa NF com recusa: a recusa que
  // chegou junto com a troca fica simulada no banco, e a reselagem do admin sela como recusada.
  db(`update "RevalleInvoiceClassification" set "financeStatus" = 'SUPERSEDED' where "envelopeId" = '${doc.id}'`);
  db(
    `update "Recipient" set "signingStatus" = 'REJECTED', "rejectionReason" = 'Teste', "signedAt" = now() where "envelopeId" = '${doc.id}'`,
  );

  const resealed = await trpcAs(adminCookie, 'mutation', 'admin.document.reseal', { id: doc.id });

  assert.ok(resealed.ok, resealed.text);
  assert.equal(await waitStatus(doc.id, 'REJECTED'), 'REJECTED');
  assert.equal((await approvalMails(doc)).length, 0);
});

const sweep = () =>
  runJobLikeTheApp({
    jobId: 'internal.seal-document-sweep',
    name: 'Seal Document Sweep',
    version: '1.0.0',
    payload: {},
  });
const approvalRequested = (envelopeId) =>
  db(
    `select "approvalRequestedAt" is not null from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );

sessionTest(
  'última assinatura sem ninguém no Financeiro: o admin vê o alerta; marcado um membro, a varredura pede a aprovação 1 vez',
  async () => {
    const members = db(`select "userId" || ',' || coalesce("addedById"::text, 'null') from "RevalleFinanceMember"`)
      .split('\n')
      .filter(Boolean);
    const doc = await newInvoice('sem-membros', { signers: 1 });

    db('delete from "RevalleFinanceMember"');

    try {
      await sign(doc, 0);
      await sleep(3000);
      assert.equal(status(doc.id), 'PENDING');
      assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
      assert.equal(approvalRequested(doc.id), 'f');

      const listed = await trpcAs(adminCookie, 'query', 'revalle.finance.adminListUsers', { query: admin.email });

      assert.equal(listed.status, 200, listed.text);
      assert.equal(data(listed).memberCount, 0);
      assert.ok(data(listed).awaitingApprovalCount >= 1, `sem a NF assinada no alerta: ${listed.text}`);

      // Sem membros, a varredura nem pede (não há a quem).
      assert.equal(await sweep(), 'COMPLETED');
      await sleep(2000);
      assert.equal(approvalRequested(doc.id), 'f');
    } finally {
      for (const member of members) {
        const [userId, addedById] = member.split(',');

        db(
          `insert into "RevalleFinanceMember" ("userId", "addedById") values (${userId}, ${addedById}) on conflict do nothing`,
        );
      }
    }

    assert.equal((await approvalMails(doc)).length, 0);

    // Com o membro de volta, a varredura de verdade pede a aprovação (em lotes: repete se outras NFs vêm antes).
    for (let i = 0; i < 5 && approvalRequested(doc.id) !== 't'; i += 1) {
      assert.equal(await sweep(), 'COMPLETED');

      for (let j = 0; j < 10 && approvalRequested(doc.id) !== 't'; j += 1) {
        await sleep(1000);
      }
    }

    assert.equal(
      (await waitMails(admin.email, (m) => m.Subject === APPROVAL_SUBJECT(doc.title))).length,
      1,
      'o pedido de aprovação não saiu depois de marcar o membro',
    );

    // Outra varredura não repete o pedido, e a NF continua retida (a varredura não sela).
    assert.equal(await sweep(), 'COMPLETED');
    await sleep(3000);
    assert.equal((await approvalMails(doc)).length, 1, 'o pedido de aprovação saiu de novo');
    assert.equal(status(doc.id), 'PENDING');
    assert.deepEqual(sealJobs(doc), [], 'a varredura disparou a selagem da NF retida');
  },
);

sessionTest(
  'NF marcada depois do envio, sem conta: "Definir e aprovar" grava a conta aprovada, sem nova versão; conclui direto',
  async () => {
    const doc = await sendDocument('definir-aprovar', { signers: 1, choice: null });
    const marked = await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: doc.id });

    assert.equal(marked.status, 200, marked.text);
    assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');

    const withoutCode = await approve(doc.id);

    assert.equal(withoutCode.status, 400, withoutCode.text);
    assert.ok(withoutCode.text.includes('Definir e aprovar'), withoutCode.text);

    assert.equal(
      (await trpcAs(userCookie, 'mutation', 'revalle.finance.approve', { envelopeId: doc.id, code: '3.1.01' })).status,
      403,
    );

    const defined = await trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', {
      envelopeId: doc.id,
      code: '3.1.01',
    });

    assert.equal(defined.status, 200, defined.text);
    assert.deepEqual(data(defined), { approved: true });
    assert.equal(
      db(
        `select "financeStatus" || '|' || "choiceCode" || '|' || "choiceById" || '|' || "approvedById" || '|' || "approvedAccountName" || '|' || coalesce("previousEnvelopeId", '-') from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`,
      ),
      `APPROVED|3.1.01|${adminId}|${adminId}|Serviços de terceiros|-`,
    );
    assert.equal(auditCount(doc.id, 'REVALLE_FINANCE_ACCOUNT_DEFINED'), 1);
    assert.equal(
      db(`select count(*) from "RevalleInvoiceClassification" where "previousEnvelopeId" = '${doc.id}'`),
      '0',
      'criou uma nova versão',
    );

    // Repetição: nada a mais; outra conta numa NF que já tem conta = 400.
    assert.deepEqual(
      data(await trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', { envelopeId: doc.id, code: '3.1.01' })),
      { approved: false },
    );
    assert.equal(auditCount(doc.id, 'REVALLE_FINANCE_ACCOUNT_DEFINED'), 1);

    await sign(doc, 0);
    assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED', 'a NF aprovada não concluiu');
  },
);

sessionTest(
  'reselagem pelo admin de uma NF concluída que ainda espera a aprovação: refaz o PDF; a aprovação continua pendente',
  async () => {
    const doc = await sendDocument('reselagem-concluida', { signers: 1, choice: null });

    await sign(doc, 0);
    assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');

    const marked = await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: doc.id });

    assert.equal(marked.status, 200, marked.text);
    assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');

    const before = itemData(doc.id);
    const resealed = await trpcAs(adminCookie, 'mutation', 'admin.document.reseal', { id: doc.id });

    assert.ok(resealed.ok, resealed.text);

    for (let i = 0; i < 45 && itemData(doc.id) === before; i += 1) {
      await sleep(1000);
    }

    assert.notEqual(itemData(doc.id), before, 'a reselagem da NF concluída foi pulada sem aviso');
    assert.equal(status(doc.id), 'COMPLETED');
    assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
    await sleep(2000);
    assert.equal((await accountingMails(doc)).length, 0, 'a reselagem mandou a NF não aprovada para a contabilidade');
  },
);
