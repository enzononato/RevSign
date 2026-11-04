// Fase 6, Task 2: envio de nota fiscal com o Financeiro. Fase 7: sem "Deixar para o Financeiro" nem "Definir conta e enviar".
//   - NF com conta: é enviada normalmente e fica `PENDING_APPROVAL` (inclusive o rascunho que a migração marcou como
//     `LEGACY`: rascunho nunca pula o Financeiro);
//   - NF sem conta: o envio é recusado (`INVOICE_ACCOUNT_REQUIRED`); nada é retido e o Financeiro não recebe aviso;
//   - `revalle.finance.resendVersion` ("Enviar de novo"): só membro do Financeiro (403), só para a nova versão de uma
//     troca de conta que ficou em rascunho (400 numa NF comum); envia em nome do dono com a MESMA conta (a conta não é
//     parâmetro), convite no Mailpit, sem evento de definição de conta, e não reenvia na 2ª chamada; envio em andamento
//     (reserva de 5 minutos) = 409; reserva vencida é retomada; recusado pelo envio de verdade solta a reserva, sem convite;
//     o dono trocar o arquivo no meio devolve a NF para ele;
//   - depois do envio o remetente não troca mais a conta (403); "Marcar como nota fiscal" depois do envio deixa a NF em
//     `PENDING_APPROVAL` e só aceita a primeira conta;
//   - o `assets/example.pdf` é enviado como antes.
//
// Sessões: REVSIGN_USER_* (admin@hml.local, dono do REVSIGN_API_TOKEN, fora do Financeiro) e REVSIGN_ADMIN_* (rsadmin,
// ADMIN, marcado como Financeiro aqui, como no finance-admin). Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

import {
  api,
  assertNoPaidGeminiCalls,
  BASE_URL,
  chooseInvoice,
  createEnvelope,
  db,
  fetchIdempotent,
  signIn,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MAILPIT = 'http://localhost:8025/api/v1';
const REQUIRED_MESSAGE = 'Escolha a conta contábil e o centro de custo.';
const NOT_A_VERSION_MESSAGE = 'Esta nota fiscal não tem uma nova versão aguardando envio.';
const FILE_CHANGED_MESSAGE = 'O remetente trocou o arquivo; a nota voltou para ele.';
const REASON = 'Conta de serviço, não de material.';
const AFTER_SEND_MESSAGE = 'Depois do envio, quem troca a conta é o Financeiro.';
const IN_PROGRESS_MESSAGE = 'O envio desta nota já está em andamento. Aguarde um instante.';

const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
].join('\n');

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-financeiro-envio-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userCookie;
let adminCookie;
let adminId;

const data = (res) => res.body?.result?.data?.json;
const setChoice = (envelopeId, choice, cookie = userCookie) =>
  trpcAs(cookie, 'mutation', 'revalle.invoice.setChoice', { envelopeId, choice });
const choose = (envelopeId, options = {}) => chooseInvoice({ cookie: userCookie, envelopeId, ...options });
const resendVersion = (envelopeId, cookie = adminCookie, extra = {}) =>
  trpcAs(cookie, 'mutation', 'revalle.finance.resendVersion', { envelopeId, ...extra });
const changeAccount = (envelopeId, code) =>
  trpcAs(adminCookie, 'mutation', 'revalle.finance.changeAccount', { envelopeId, code, reason: REASON });
const distribute = (envelopeId) => api('POST', '/envelope/distribute', { envelopeId });
const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);
const financeStatus = (envelopeId) =>
  db(
    `select coalesce("financeStatus"::text, '-') from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );
const auditCount = (envelopeId, type) =>
  Number(db(`select count(*) from "DocumentAuditLog" where "envelopeId" = '${envelopeId}' and type = '${type}'`));

const mailsTo = async (to) =>
  (await fetchIdempotent(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`, {}, (res) => res.json()))
    .messages ?? [];

const waitMails = async (to, filter = () => true, timeoutMs = 30_000) => {
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

const textPdf = async (lines) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  let y = 800;

  for (const line of lines) {
    page.drawText(line, { x: 40, y, size: 10, font, color: rgb(0, 0, 0) });
    y -= 16;
  }

  return Buffer.from(await doc.save());
};

// DANFE fictício; `variant` muda o arquivo (outra SHA-256, sem cache da sugestão).
const danfe = async (variant) => {
  const file = path.join(tmp, `danfe-${variant}.pdf`);

  writeFileSync(
    file,
    await textPdf([
      'DANFE - Documento Auxiliar da Nota Fiscal Eletrônica',
      'Nº 000.012.345   Série 001',
      'Chave de Acesso',
      '2924 1012 3456 7800 0195 5500 1000 0123 4511 2345 6784',
      'Natureza da Operação: Venda de mercadoria adquirida de terceiros',
      'Emitente: Distribuidora Fictícia de Ferragens Ltda   CNPJ 12.345.678/0001-95',
      `Referência do teste: financeiro envio ${variant} ${RUN}`,
      'Valor Total da Nota: R$ 150,00',
    ]),
  );

  return file;
};

// Documento do usuário comum, com convite por e-mail (para conferir no Mailpit que ele sai, ou não).
const newDocument = async (pdf, label) => {
  const recipient = `f6-envio-${label}-${RUN}@revalle.com.br`;
  const title = `[TESTE NF] financeiro envio ${label} ${RUN}`;
  const created = await createEnvelope({
    recipients: [{ email: recipient }],
    pdf,
    title,
    meta: { distributionMethod: 'EMAIL' },
  });

  assert.equal(created.status, 200, created.text);

  return { id: created.id, title, recipient, secondaryId: created.envelope.secondaryId };
};

const invites = async (doc) => (await mailsTo(doc.recipient)).length;

// A nova versão de uma troca recebe dois e-mails de quem age nela: o convite e o aviso da troca (que só sai no envio).
const NOTICE_PREFIX = 'Conta contábil da nota fiscal alterada pelo Financeiro:';
const isInvite = (mail) => !mail.Subject.startsWith(NOTICE_PREFIX);
const isNotice = (mail) => mail.Subject.startsWith(NOTICE_PREFIX);
const inviteCount = async (email) => (await mailsTo(email)).filter(isInvite).length;

// Troca de conta cujo envio da nova versão é recusado (destinatário de fora dos domínios, posto no banco depois do
// envio da v1): a v2 fica rascunho `APPROVED` com a conta nova e a reserva solta, e quem é do Financeiro a reenvia.
const failedVersion = async (label) => {
  const doc = await newDocument(await danfe(label), label);

  assert.equal((await choose(doc.id)).status, 200);
  assert.equal((await distribute(doc.id)).status, 200);
  db(`update "Recipient" set email = 'f7-fora-${label}-${RUN}@example.com' where "envelopeId" = '${doc.id}'`);

  const changed = await changeAccount(doc.id, '3.1.01');

  assert.equal(changed.status, 409, changed.text);
  assert.equal(changed.body?.error?.json?.data?.code, 'FINANCE_NEW_VERSION_NOT_SENT', changed.text);

  const v2 = db(`select "supersededByEnvelopeId" from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`);

  assert.ok(v2, 'a v2 não ficou criada');
  assert.equal(status(v2), 'DRAFT');
  assert.equal(released(v2), 'APPROVED|3.1.01|true');

  return { doc, v2, fixed: `f7-reenvio-${label}-${RUN}@revalle.com.br` };
};

const fixRecipient = (v2, email) => db(`update "Recipient" set email = '${email}' where "envelopeId" = '${v2}'`);

// Estado e reserva da v2: `true` = reserva solta (o envio falhou e o próximo sai na hora).
const released = (envelopeId) =>
  db(
    `select "financeStatus" || '|' || "choiceCode" || '|' || ("approvedAt" is null) from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
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
});

sessionTest('NF com conta: é enviada e fica aguardando a aprovação do Financeiro', async () => {
  const doc = await newDocument(await danfe('com-conta'), 'com-conta');

  assert.equal((await choose(doc.id)).status, 200);

  const sent = await distribute(doc.id);

  assert.equal(sent.status, 200, sent.text);
  assert.equal(status(doc.id), 'PENDING');
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
  assert.equal((await waitMails(doc.recipient)).length, 1, 'o convite não chegou');

  // O cartão do remetente lê o estado do Financeiro.
  const state = data(await trpcAs(userCookie, 'query', 'revalle.invoice.get', { envelopeId: doc.id }));

  assert.equal(state.financeStatus, 'PENDING_APPROVAL');

  // Depois do envio, quem troca a conta é o Financeiro (nem o dono, nem o admin por esta rota).
  for (const cookie of [userCookie, adminCookie]) {
    const changed = await setChoice(doc.id, { code: '3.1.01' }, cookie);

    assert.equal(changed.status, 403, changed.text);
    assert.ok(changed.text.includes(AFTER_SEND_MESSAGE), changed.text);
  }

  assert.equal(
    db(`select "choiceCode" from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`),
    '2.1.03',
  );

  // "Enviar de novo" só serve para a nova versão de uma troca de conta: numa NF enviada comum, 400 e nada muda.
  const notVersion = await resendVersion(doc.id);

  assert.equal(notVersion.status, 400, notVersion.text);
  assert.ok(notVersion.text.includes(NOT_A_VERSION_MESSAGE), notVersion.text);
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
});

sessionTest('rascunho marcado LEGACY pela migração: ao enviar com conta, vai para PENDING_APPROVAL', async () => {
  const doc = await newDocument(await danfe('legacy-rascunho'), 'legacy-rascunho');

  assert.equal((await choose(doc.id)).status, 200);
  // Simula uma NF em rascunho antes da Fase 6 (a migração marcou todas as NFs como LEGACY).
  db(`update "RevalleInvoiceClassification" set "financeStatus" = 'LEGACY' where "envelopeId" = '${doc.id}'`);

  const sent = await distribute(doc.id);

  assert.equal(sent.status, 200, sent.text);
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
});

sessionTest('NF sem conta: o envio é recusado, nada é retido e o Financeiro não recebe aviso', async () => {
  const doc = await newDocument(await danfe('sem-conta'), 'sem-conta');
  const refused = await distribute(doc.id);

  assert.equal(refused.status, 400, refused.text);
  assert.ok(refused.text.includes('INVOICE_ACCOUNT_REQUIRED'), refused.text);
  assert.ok(refused.text.includes(REQUIRED_MESSAGE), refused.text);

  const documentId = doc.secondaryId.replace(/\D/g, '');
  const viaV1 = await fetch(`${BASE_URL}/api/v1/documents/${documentId}/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  assert.equal(viaV1.status, 400, await viaV1.text());
  assert.equal(status(doc.id), 'DRAFT');
  assert.equal(financeStatus(doc.id), '-');

  await sleep(3000);
  assert.equal(auditCount(doc.id, 'DOCUMENT_SENT'), 0);
  assert.equal(await invites(doc), 0, 'convite saiu de um envio recusado');
  assert.equal(
    (await mailsTo(admin.email)).filter((m) => m.Subject.includes(doc.title)).length,
    0,
    'o Financeiro recebeu aviso de uma NF sem conta',
  );
});

sessionTest('resendVersion numa NF comum em rascunho: 400, e nada muda', async () => {
  const doc = await newDocument(await danfe('comum-rascunho'), 'comum-rascunho');

  assert.equal((await setChoice(doc.id, { code: '2.1.03' })).status, 200);

  const refused = await resendVersion(doc.id);

  assert.equal(refused.status, 400, refused.text);
  assert.ok(refused.text.includes(NOT_A_VERSION_MESSAGE), refused.text);
  assert.equal(status(doc.id), 'DRAFT');
  assert.equal(financeStatus(doc.id), '-');
  assert.equal(
    db(`select "choiceCode" from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`),
    '2.1.03',
  );
  assert.equal(auditCount(doc.id, 'DOCUMENT_SENT'), 0);

  // Documento que não é NF: 404.
  const plain = await newDocument('assets/example.pdf', 'comum-sem-nf');

  assert.equal((await resendVersion(plain.id)).status, 404);
  assert.equal(status(plain.id), 'DRAFT');
});

sessionTest('resendVersion: quem não é do Financeiro recebe 403; sem sessão, 401; nada muda', async () => {
  const { v2 } = await failedVersion('acesso');

  assert.equal((await resendVersion(v2, userCookie)).status, 403);
  assert.equal((await resendVersion(v2, '')).status, 401);
  assert.equal(status(v2), 'DRAFT');
  assert.equal(released(v2), 'APPROVED|3.1.01|true');
});

sessionTest(
  'resendVersion: recusado pelo envio de verdade solta a reserva, sem convite; corrigido, sai com a mesma conta',
  async () => {
    const { doc, v2, fixed } = await failedVersion('reenvio');

    // O destinatário continua de fora: o envio de verdade recusa, a v2 segue rascunho aprovado e a reserva fica solta.
    const refused = await resendVersion(v2);

    assert.ok(refused.status >= 400 && refused.status < 500, `${refused.status}: ${refused.text}`);
    assert.equal(status(v2), 'DRAFT');
    assert.equal(released(v2), 'APPROVED|3.1.01|true');
    assert.equal(auditCount(v2, 'DOCUMENT_SENT'), 0);

    fixRecipient(v2, fixed);

    // A conta não é parâmetro: um `code` mandado junto é ignorado e a v2 sai com a conta da troca.
    const sent = await resendVersion(v2, adminCookie, { code: '2.1.03' });

    assert.equal(sent.status, 200, sent.text);
    assert.deepEqual(data(sent), { sent: true });
    assert.equal(status(v2), 'PENDING');
    assert.equal(
      db(
        `select "financeStatus" || ';' || "choiceCode" || ';' || "approvedById" || ';' || ("approvedAt" = "choiceAt") from "RevalleInvoiceClassification" where "envelopeId" = '${v2}'`,
      ),
      `APPROVED;3.1.01;${adminId};true`,
    );
    // O dono continua o mesmo e o convite chega a quem corrigiu.
    assert.equal(
      db(`select u.email from "Envelope" e join "User" u on u.id = e."userId" where e.id = '${v2}'`),
      user.email,
    );
    assert.equal((await waitMails(fixed, isInvite)).length, 1, 'o convite não chegou');
    assert.equal((await waitMails(fixed, isNotice)).length, 1, 'o aviso da troca não chegou');
    assert.equal(auditCount(v2, 'DOCUMENT_SENT'), 1);
    // A troca já tem o evento dela; o reenvio não inventa a "definição de conta" do fluxo que saiu.
    assert.equal(auditCount(v2, 'REVALLE_FINANCE_ACCOUNT_DEFINED'), 0);
    assert.equal(financeStatus(doc.id), 'SUPERSEDED');

    // 2ª chamada (clique duplo ou repetição): nada é reenviado.
    const again = await resendVersion(v2);

    assert.equal(again.status, 200, again.text);
    assert.deepEqual(data(again), { sent: false });
    await sleep(3000);
    assert.equal(auditCount(v2, 'DOCUMENT_SENT'), 1);
    assert.equal((await mailsTo(fixed)).length, 2, 'o reenvio repetido mandou e-mail de novo');

    // O remetente vê "Aprovada" e continua sem trocar a conta.
    const state = data(await trpcAs(userCookie, 'query', 'revalle.invoice.get', { envelopeId: v2 }));

    assert.equal(state.financeStatus, 'APPROVED');
    assert.deepEqual(state.choice, { code: '3.1.01', name: 'Serviços de terceiros' });
    assert.equal((await setChoice(v2, { code: '2.1.03' })).status, 403);
  },
);

sessionTest('resendVersion concorrente (clique duplo): um envio só', async () => {
  const { v2, fixed } = await failedVersion('corrida');

  fixRecipient(v2, fixed);

  const results = await Promise.all([resendVersion(v2), resendVersion(v2)]);
  const statuses = results.map((res) => res.status).sort();
  const texts = results.map((res) => res.text).join('\n');

  // Quem perde recebe 200 sem reenviar (o outro já enviou) ou 409 "em andamento" (o outro ainda está enviando).
  assert.ok(isDeepStrictEqual(statuses, [200, 200]) || isDeepStrictEqual(statuses, [200, 409]), texts);
  assert.equal(results.filter((res) => res.status === 200 && data(res).sent === true).length, 1, texts);

  if (statuses[1] === 409) {
    assert.ok(texts.includes(IN_PROGRESS_MESSAGE), texts);
  }

  assert.equal(status(v2), 'PENDING');
  await sleep(3000);
  assert.equal(auditCount(v2, 'DOCUMENT_SENT'), 1);
  assert.equal(await inviteCount(fixed), 1);
  assert.equal((await mailsTo(fixed)).filter(isNotice).length, 1);
});

sessionTest(
  'resendVersion com um envio em andamento (reserva com menos de 5 minutos): 409; reserva vencida é retomada',
  async () => {
    const { v2, fixed } = await failedVersion('andamento');

    fixRecipient(v2, fixed);

    // O envio de outro pedido está em andamento (ou caiu): a reserva vale 5 minutos, o envio de um PDF grande demora.
    const reserve = (age) =>
      db(
        `update "RevalleInvoiceClassification" set "approvedAt" = now() - interval '${age}' where "envelopeId" = '${v2}'`,
      );

    reserve('4 minutes');

    const busy = await resendVersion(v2);

    assert.equal(busy.status, 409, busy.text);
    assert.ok(busy.text.includes(IN_PROGRESS_MESSAGE), busy.text);
    assert.equal(status(v2), 'DRAFT');

    // O remetente também não mexe enquanto o Financeiro envia.
    const changed = await setChoice(v2, { code: '2.1.03' });

    assert.equal(changed.status, 403, changed.text);
    assert.ok(changed.text.includes(AFTER_SEND_MESSAGE), changed.text);

    reserve('6 minutes');

    const recovered = await resendVersion(v2);

    assert.equal(recovered.status, 200, recovered.text);
    assert.deepEqual(data(recovered), { sent: true });
    assert.equal(status(v2), 'PENDING');
    assert.equal((await waitMails(fixed, isInvite)).length, 1, 'o convite não chegou');
    await sleep(2000);
    assert.equal(await inviteCount(fixed), 1);
    assert.equal(auditCount(v2, 'DOCUMENT_SENT'), 1);
  },
);

sessionTest(
  'o dono troca o arquivo durante o "Enviar de novo": o Financeiro recebe "O remetente trocou o arquivo"',
  async () => {
    const { v2, fixed } = await failedVersion('arquivo-trocado');

    fixRecipient(v2, fixed);

    // A classificação ainda não viu o arquivo novo (a troca chegou entre a leitura do Financeiro e o envio): o envio
    // reclassifica, a conta é zerada e a NF volta a ser um rascunho do dono.
    db(`update "RevalleInvoiceClassification" set "fileSha256" = 'arquivo-anterior' where "envelopeId" = '${v2}'`);

    const refused = await resendVersion(v2);

    assert.equal(refused.status, 400, refused.text);
    assert.ok(refused.text.includes(FILE_CHANGED_MESSAGE), refused.text);
    assert.equal(status(v2), 'DRAFT');
    assert.equal(financeStatus(v2), '-');
    await sleep(2000);
    assert.equal((await mailsTo(fixed)).length, 0);
    assert.equal(auditCount(v2, 'DOCUMENT_SENT'), 0);

    // De volta ao dono: ele escolhe a conta e o centro de novo e envia como qualquer NF (aguarda a aprovação).
    assert.equal((await choose(v2)).status, 200);
    assert.equal((await distribute(v2)).status, 200);
    assert.equal(financeStatus(v2), 'PENDING_APPROVAL');
  },
);

sessionTest('marcar como NF depois do envio: PENDING_APPROVAL; o dono escolhe a primeira conta e só', async () => {
  const doc = await newDocument('assets/example.pdf', 'marcar');

  assert.equal((await distribute(doc.id)).status, 200);

  const marked = await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: doc.id });

  assert.equal(marked.status, 200, marked.text);
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');

  assert.equal((await setChoice(doc.id, { code: '2.1.03' })).status, 200);

  const changed = await setChoice(doc.id, { code: '3.1.01' });

  assert.equal(changed.status, 403, changed.text);
  assert.ok(changed.text.includes(AFTER_SEND_MESSAGE), changed.text);
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
});

sessionTest('assets/example.pdf: enviado como antes, sem estado do Financeiro', async () => {
  const doc = await newDocument('assets/example.pdf', 'comum');
  const sent = await distribute(doc.id);

  assert.equal(sent.status, 200, sent.text);
  assert.equal(status(doc.id), 'PENDING');
  assert.equal(financeStatus(doc.id), '-');
  assert.equal((await waitMails(doc.recipient)).length, 1, 'o convite não chegou');
});
