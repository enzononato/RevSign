// Fase 6, Task 2: envio de nota fiscal com o Financeiro.
//   - NF com conta: é enviada normalmente e fica `PENDING_APPROVAL` (inclusive o rascunho que a migração marcou como
//     `LEGACY`: rascunho nunca pula o Financeiro);
//   - "Deixar para o Financeiro": o envio fica RETIDO (rascunho, sem convites; resposta 409 `INVOICE_HELD_FOR_FINANCE`
//     na tela e nas APIs v1/v2), o estado vai para `AWAITING_ACCOUNT` e os membros do Financeiro recebem UM e-mail por
//     retenção; sem ninguém no Financeiro, a retenção acontece mesmo assim e o admin vê o aviso na tela Admin → Financeiro;
//   - `revalle.finance.defineAccount`: só membro do Financeiro (403), só em `AWAITING_ACCOUNT`; grava a conta já
//     aprovada, envia em nome do dono (convites no Mailpit), registra no log de auditoria e não reenvia na 2ª chamada;
//     envio do Financeiro em andamento = 409; caído no meio (reserva de 2 minutos vencida) é retomado; recusado pelo
//     envio de verdade volta a aguardar a conta, sem convite;
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
const HELD_MESSAGE = 'Enviado para o Financeiro definir a conta. Os convites saem depois disso.';
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
const defineAccount = (envelopeId, code, cookie = adminCookie) =>
  trpcAs(cookie, 'mutation', 'revalle.finance.defineAccount', { envelopeId, code });
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

const financeMails = async (title) =>
  (await mailsTo(admin.email)).filter((m) => m.Subject === `Nota fiscal aguardando o Financeiro: ${title}`);

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

const assertHeld = (res) => {
  assert.equal(res.status, 409, res.text);
  assert.ok(res.text.includes('INVOICE_HELD_FOR_FINANCE'), res.text);
  assert.ok(res.text.includes(HELD_MESSAGE), res.text);
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
});

sessionTest('NF com conta: é enviada e fica aguardando a aprovação do Financeiro', async () => {
  const doc = await newDocument(await danfe('com-conta'), 'com-conta');

  assert.equal((await setChoice(doc.id, { code: '2.1.03' })).status, 200);

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

  // Só NF aguardando a conta pode ser definida.
  const notHeld = await defineAccount(doc.id, '3.1.01');

  assert.equal(notHeld.status, 400, notHeld.text);
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
});

sessionTest('rascunho marcado LEGACY pela migração: ao enviar com conta, vai para PENDING_APPROVAL', async () => {
  const doc = await newDocument(await danfe('legacy-rascunho'), 'legacy-rascunho');

  assert.equal((await setChoice(doc.id, { code: '2.1.03' })).status, 200);
  // Simula uma NF em rascunho antes da Fase 6 (a migração marcou todas as NFs como LEGACY).
  db(`update "RevalleInvoiceClassification" set "financeStatus" = 'LEGACY' where "envelopeId" = '${doc.id}'`);

  const sent = await distribute(doc.id);

  assert.equal(sent.status, 200, sent.text);
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
});

let held;

sessionTest(
  '"Deixar para o Financeiro": envio retido (tela, API v1 e v2), sem convites, e 1 e-mail ao Financeiro',
  async () => {
    held = await newDocument(await danfe('deixar'), 'deixar');

    assert.equal((await setChoice(held.id, { defer: true })).status, 200);
    // Rascunho de antes da Fase 6: também é retido.
    db(`update "RevalleInvoiceClassification" set "financeStatus" = 'LEGACY' where "envelopeId" = '${held.id}'`);

    // A tela (tRPC, com a sessão do remetente).
    const teamId = db(`select "teamId" from "Envelope" where id = '${held.id}'`);
    const viaScreen = await trpcAs(
      userCookie,
      'mutation',
      'envelope.distribute',
      { envelopeId: held.id },
      { 'x-team-id': teamId },
    );

    assertHeld(viaScreen);
    assert.equal(status(held.id), 'DRAFT');
    assert.equal(financeStatus(held.id), 'AWAITING_ACCOUNT');

    const [notice] = await waitMails(
      admin.email,
      (m) => m.Subject === `Nota fiscal aguardando o Financeiro: ${held.title}`,
    );

    assert.ok(notice, 'o e-mail do Financeiro não chegou');

    // API v2 e API v1: a mesma retenção, sem novo e-mail (um por retenção).
    assertHeld(await distribute(held.id));

    const documentId = held.secondaryId.replace(/\D/g, '');
    const viaV1 = await fetch(`${BASE_URL}/api/v1/documents/${documentId}/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const v1Text = await viaV1.text();

    assert.equal(viaV1.status, 409, v1Text);
    assert.ok(v1Text.includes(HELD_MESSAGE), v1Text);

    await sleep(3000);
    assert.equal(status(held.id), 'DRAFT');
    assert.equal(auditCount(held.id, 'DOCUMENT_SENT'), 0);
    assert.equal(await invites(held), 0, 'convite saiu de um envio retido');
    assert.equal((await financeMails(held.title)).length, 1);

    // O remetente vê o estado e não troca mais a escolha (nem diz que não é NF) enquanto o Financeiro decide.
    const state = data(await trpcAs(userCookie, 'query', 'revalle.invoice.get', { envelopeId: held.id }));

    assert.equal(state.financeStatus, 'AWAITING_ACCOUNT');

    const changed = await setChoice(held.id, { code: '2.1.03' });

    assert.equal(changed.status, 403, changed.text);
    assert.ok(changed.text.includes(AFTER_SEND_MESSAGE), changed.text);

    const flag = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setInvoiceFlag', {
      envelopeId: held.id,
      isInvoice: false,
    });

    assert.equal(flag.status, 403, flag.text);
    assert.equal(financeStatus(held.id), 'AWAITING_ACCOUNT');
  },
);

sessionTest('defineAccount: quem não é do Financeiro recebe 403; sem sessão, 401; nada muda', async () => {
  assert.ok(held, 'depende do caso "Deixar para o Financeiro"');

  const refused = await defineAccount(held.id, '2.1.03', userCookie);

  assert.equal(refused.status, 403, refused.text);
  assert.equal((await defineAccount(held.id, '2.1.03', '')).status, 401);
  assert.equal(status(held.id), 'DRAFT');
  assert.equal(financeStatus(held.id), 'AWAITING_ACCOUNT');
});

sessionTest(
  'defineAccount pelo Financeiro: conta aprovada, enviado em nome do dono, convite e log; 2ª chamada não reenvia',
  async () => {
    assert.ok(held, 'depende do caso "Deixar para o Financeiro"');

    // Conta inativa ou inexistente: 400, nada muda.
    assert.equal((await defineAccount(held.id, `X.${RUN}`)).status, 400);
    assert.equal(financeStatus(held.id), 'AWAITING_ACCOUNT');

    const defined = await defineAccount(held.id, '3.1.01');

    assert.equal(defined.status, 200, defined.text);
    assert.equal(status(held.id), 'PENDING');
    assert.equal(
      db(
        `select "financeStatus" || ';' || coalesce("choiceCode", '-') || ';' || "choiceDefer" || ';' || "approvedById" || ';' || ("approvedAt" is not null) from "RevalleInvoiceClassification" where "envelopeId" = '${held.id}'`,
      ),
      `APPROVED;3.1.01;false;${adminId};true`,
    );
    // O dono continua o mesmo.
    assert.equal(
      db(`select u.email from "Envelope" e join "User" u on u.id = e."userId" where e.id = '${held.id}'`),
      user.email,
    );
    assert.equal((await waitMails(held.recipient)).length, 1, 'o convite não chegou');

    const events = JSON.parse(
      db(
        `select coalesce(json_agg(json_build_object('data', data, 'email', email)), '[]') from "DocumentAuditLog" where "envelopeId" = '${held.id}' and type = 'REVALLE_FINANCE_ACCOUNT_DEFINED'`,
      ),
    );

    assert.equal(events.length, 1, JSON.stringify(events));
    assert.deepEqual(events[0].data, { code: '3.1.01', name: 'Serviços de terceiros' });
    assert.equal(events[0].email, admin.email);

    // 2ª chamada (clique duplo ou repetição): nada é reenviado nem registrado de novo.
    const again = await defineAccount(held.id, '3.1.01');

    assert.equal(again.status, 200, again.text);
    await sleep(3000);
    assert.equal(auditCount(held.id, 'DOCUMENT_SENT'), 1);
    assert.equal(auditCount(held.id, 'REVALLE_FINANCE_ACCOUNT_DEFINED'), 1);
    assert.equal(await invites(held), 1);

    // Outra conta depois de definida: não é por aqui (a troca é outra rota).
    assert.equal((await defineAccount(held.id, '2.1.03')).status, 400);

    // O remetente vê "Aprovada pelo Financeiro" e continua sem trocar a conta.
    const state = data(await trpcAs(userCookie, 'query', 'revalle.invoice.get', { envelopeId: held.id }));

    assert.equal(state.financeStatus, 'APPROVED');
    assert.deepEqual(state.choice, { code: '3.1.01', name: 'Serviços de terceiros' });
    assert.equal((await setChoice(held.id, { code: '2.1.03' })).status, 403);
  },
);

sessionTest('defineAccount concorrente (clique duplo): um envio só', async () => {
  const doc = await newDocument(await danfe('corrida'), 'corrida');

  assert.equal((await setChoice(doc.id, { defer: true })).status, 200);
  assertHeld(await distribute(doc.id));

  const results = await Promise.all([defineAccount(doc.id, '2.1.03'), defineAccount(doc.id, '2.1.03')]);
  const statuses = results.map((res) => res.status).sort();
  const texts = results.map((res) => res.text).join('\n');

  // Quem perde recebe 200 sem reenviar (o outro já enviou) ou 409 "em andamento" (o outro ainda está enviando).
  assert.ok(isDeepStrictEqual(statuses, [200, 200]) || isDeepStrictEqual(statuses, [200, 409]), texts);

  if (statuses[1] === 409) {
    assert.ok(texts.includes(IN_PROGRESS_MESSAGE), texts);
  }

  assert.equal(status(doc.id), 'PENDING');
  await sleep(3000);
  assert.equal(auditCount(doc.id, 'DOCUMENT_SENT'), 1);
  assert.equal(auditCount(doc.id, 'REVALLE_FINANCE_ACCOUNT_DEFINED'), 1);
  assert.equal(await invites(doc), 1);
});

sessionTest(
  'envio do Financeiro que caiu no meio (APPROVED em rascunho): em andamento = 409; reserva vencida é retomada',
  async () => {
    const doc = await newDocument(await danfe('preso'), 'preso');

    assert.equal((await setChoice(doc.id, { defer: true })).status, 200);
    assertHeld(await distribute(doc.id));

    // O processo caiu entre a gravação da conta e o envio: APPROVED, com o documento ainda em rascunho.
    const stuck = (age) =>
      db(
        `update "RevalleInvoiceClassification" set "financeStatus" = 'APPROVED', "choiceCode" = '2.1.03', "choiceDefer" = false, "approvedById" = ${adminId}, "approvedAt" = now() - interval '${age}' where "envelopeId" = '${doc.id}'`,
      );

    // A reserva vale 5 minutos (o envio de um PDF grande pode demorar): com 4, ainda está em andamento.
    stuck('4 minutes');

    const busy = await defineAccount(doc.id, '3.1.01');

    assert.equal(busy.status, 409, busy.text);
    assert.ok(busy.text.includes(IN_PROGRESS_MESSAGE), busy.text);

    // O remetente também não mexe enquanto o Financeiro envia.
    const changed = await setChoice(doc.id, { code: '2.1.03' });

    assert.equal(changed.status, 403, changed.text);
    assert.ok(changed.text.includes(AFTER_SEND_MESSAGE), changed.text);

    stuck('6 minutes');

    const recovered = await defineAccount(doc.id, '3.1.01');

    assert.equal(recovered.status, 200, recovered.text);
    assert.equal(data(recovered).sent, true);
    assert.equal(status(doc.id), 'PENDING');
    assert.equal(
      db(
        `select "financeStatus" || ';' || "choiceCode" || ';' || ("approvedAt" > now() - interval '1 minute') from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`,
      ),
      'APPROVED;3.1.01;true',
    );
    assert.equal((await waitMails(doc.recipient)).length, 1, 'o convite não chegou');
    await sleep(2000);
    assert.equal(await invites(doc), 1);
    assert.equal(auditCount(doc.id, 'DOCUMENT_SENT'), 1);
  },
);

sessionTest(
  'envio do Financeiro recusado depois da retenção: 4xx, volta a aguardar, rascunho, sem convite; corrigido, envia',
  async () => {
    const doc = await newDocument(await danfe('recusado'), 'recusado');

    assert.equal((await setChoice(doc.id, { defer: true })).status, 200);
    assertHeld(await distribute(doc.id));

    // Depois da retenção, o destinatário passa a ser de fora da empresa: o envio de verdade recusa.
    const outside = `f6-fora-${RUN}@example.com`;

    db(`update "Recipient" set email = '${outside}' where "envelopeId" = '${doc.id}'`);

    const refused = await defineAccount(doc.id, '2.1.03');

    assert.ok(refused.status >= 400 && refused.status < 500, `${refused.status}: ${refused.text}`);
    assert.equal(financeStatus(doc.id), 'AWAITING_ACCOUNT');
    assert.equal(
      db(
        `select "choiceDefer" || ';' || coalesce("choiceCode", '-') || ';' || coalesce("approvedAt"::text, '-') from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`,
      ),
      'true;-;-',
    );
    assert.equal(status(doc.id), 'DRAFT');
    await sleep(2000);
    assert.equal((await mailsTo(outside)).length, 0);
    assert.equal(await invites(doc), 0);
    assert.equal(auditCount(doc.id, 'REVALLE_FINANCE_ACCOUNT_DEFINED'), 0);

    db(`update "Recipient" set email = '${doc.recipient}' where "envelopeId" = '${doc.id}'`);

    const sent = await defineAccount(doc.id, '2.1.03');

    assert.equal(sent.status, 200, sent.text);
    assert.equal(status(doc.id), 'PENDING');
    assert.equal(financeStatus(doc.id), 'APPROVED');
    assert.equal((await waitMails(doc.recipient)).length, 1, 'o convite não chegou');
  },
);

sessionTest(
  'o dono troca o arquivo durante o "Definir conta e enviar": o Financeiro recebe "O remetente trocou o arquivo"',
  async () => {
    const doc = await newDocument(await danfe('arquivo-trocado'), 'arquivo-trocado');

    assert.equal((await setChoice(doc.id, { defer: true })).status, 200);
    assertHeld(await distribute(doc.id));

    // A classificação ainda não viu o arquivo novo (a troca chegou entre a leitura do Financeiro e o envio): o envio
    // reclassifica, a conta é zerada e a NF volta a ser um rascunho do dono.
    db(`update "RevalleInvoiceClassification" set "fileSha256" = 'arquivo-anterior' where "envelopeId" = '${doc.id}'`);

    const refused = await defineAccount(doc.id, '2.1.03');

    assert.equal(refused.status, 400, refused.text);
    assert.ok(refused.text.includes('O remetente trocou o arquivo; a nota voltou para ele.'), refused.text);
    assert.equal(status(doc.id), 'DRAFT');
    assert.equal(financeStatus(doc.id), '-');
    assert.equal(auditCount(doc.id, 'REVALLE_FINANCE_ACCOUNT_DEFINED'), 0);
    await sleep(2000);
    assert.equal(await invites(doc), 0);
  },
);

sessionTest(
  'envio do Financeiro retomado que falha, enviado depois pelo dono: a definição fica no log (quem do Financeiro definiu)',
  async () => {
    const doc = await newDocument(await danfe('retomada-dono'), 'retomada-dono');

    assert.equal((await setChoice(doc.id, { defer: true })).status, 200);
    assertHeld(await distribute(doc.id));

    // Reserva vencida (o envio anterior caiu) e um destinatário que o envio recusa: a retomada falha e solta a reserva.
    db(
      `update "RevalleInvoiceClassification" set "financeStatus" = 'APPROVED', "choiceCode" = '2.1.03', "choiceDefer" = false, "choiceById" = ${adminId}, "choiceAt" = now() - interval '6 minutes', "approvedById" = ${adminId}, "approvedAt" = now() - interval '6 minutes' where "envelopeId" = '${doc.id}'`,
    );
    db(`update "Recipient" set email = 'f6-envio-fora-retomada-${RUN}@example.com' where "envelopeId" = '${doc.id}'`);

    const failed = await defineAccount(doc.id, '2.1.03');

    assert.ok(failed.status >= 400 && failed.status < 500, failed.text);
    assert.equal(
      db(
        `select "financeStatus" || ';' || ("approvedAt" is null) from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`,
      ),
      'APPROVED;true',
    );

    db(`update "Recipient" set email = '${doc.recipient}' where "envelopeId" = '${doc.id}'`);

    const sent = await distribute(doc.id);

    assert.equal(sent.status, 200, sent.text);
    assert.equal(status(doc.id), 'PENDING');
    assert.equal(auditCount(doc.id, 'REVALLE_FINANCE_ACCOUNT_DEFINED'), 1, 'sem o evento da definição do Financeiro');
    assert.equal(
      db(
        `select "userId" || ';' || (data->>'code') from "DocumentAuditLog" where "envelopeId" = '${doc.id}' and type = 'REVALLE_FINANCE_ACCOUNT_DEFINED'`,
      ),
      `${adminId};2.1.03`,
    );
    assert.equal(
      db(
        `select ("approvedAt" = "choiceAt") || ';' || ("approvedByName" is not distinct from (select nullif(trim(name), '') from "User" where id = ${adminId})) from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`,
      ),
      'true;true',
    );
  },
);

sessionTest(
  'sem ninguém no Financeiro: retém mesmo assim e o admin vê o aviso; com membro de volta, o e-mail sai',
  async () => {
    const members = db(`select "userId" || ',' || coalesce("addedById"::text, 'null') from "RevalleFinanceMember"`)
      .split('\n')
      .filter(Boolean);
    const doc = await newDocument(await danfe('sem-membros'), 'sem-membros');

    assert.equal((await setChoice(doc.id, { defer: true })).status, 200);
    db('delete from "RevalleFinanceMember"');

    try {
      assertHeld(await distribute(doc.id));
      assert.equal(financeStatus(doc.id), 'AWAITING_ACCOUNT');

      const listed = await trpcAs(adminCookie, 'query', 'revalle.finance.adminListUsers', { query: admin.email });

      assert.equal(listed.status, 200, listed.text);
      assert.equal(data(listed).memberCount, 0);
      assert.ok(data(listed).awaitingAccountCount >= 1, listed.text);
    } finally {
      for (const member of members) {
        const [userId, addedById] = member.split(',');

        db(
          `insert into "RevalleFinanceMember" ("userId", "addedById") values (${userId}, ${addedById}) on conflict do nothing`,
        );
      }
    }

    await sleep(2000);
    assert.equal((await financeMails(doc.title)).length, 0);

    // Nenhum e-mail foi "gasto" sem destinatário: o próximo envio retido avisa o Financeiro.
    assertHeld(await distribute(doc.id));
    assert.equal(
      (await waitMails(admin.email, (m) => m.Subject === `Nota fiscal aguardando o Financeiro: ${doc.title}`)).length,
      1,
    );
  },
);

sessionTest('marcar como NF depois do envio: PENDING_APPROVAL; o dono escolhe a primeira conta e só', async () => {
  const doc = await newDocument('assets/example.pdf', 'marcar');

  assert.equal((await distribute(doc.id)).status, 200);

  const marked = await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: doc.id });

  assert.equal(marked.status, 200, marked.text);
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');

  // Depois do envio não há "deixar para o Financeiro": o documento já saiu.
  assert.equal((await setChoice(doc.id, { defer: true })).status, 400);
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
