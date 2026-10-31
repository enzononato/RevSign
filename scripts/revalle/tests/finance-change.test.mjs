// Fase 6, Task 4: o Financeiro troca a conta contábil de uma NF = NOVA VERSÃO que todos assinam de novo.
//   - NF com 2 signatários, um já assinou: `revalle.finance.changeAccount` com o motivo. A versão antiga fica
//     `SUPERSEDED` (quem, quando, motivo, ligação), some das listas (excluída sem e-mail de cancelamento) e o link antigo,
//     mesmo com a página aberta (portão já passado), recebe a mensagem do portão na próxima ação (assinar campo, pedir o
//     código, concluir, recusar, abrir a página). A v2 tem o título "(v2)", os mesmos destinatários e campos, o mesmo
//     dono, a conta nova `APPROVED` (quem trocou), `version` 2 e a ligação; foi enviada. O Mailpit tem o aviso exato
//     (com o motivo) para o remetente (botão: a página da NF) e os 2 signatários (botão: o link de assinatura de cada
//     um na v2), e os convites da v2. Evento nas duas versões;
//   - os dois assinam a v2 → concluída (já aprovada, sela direto);
//   - motivo curto/longo, mesma conta, conta inativa, estados que não cabem = 400; fora do Financeiro 403; sem sessão
//     401; documento comum 404;
//   - duas trocas ao mesmo tempo = exatamente 1 v2;
//   - NF concluída: a antiga continua COMPLETED (visível) e `SUPERSEDED`, a v2 sai;
//   - NF retida (todos assinaram, aguardando aprovação): a antiga nunca é selada (varredura de verdade, reselagem do
//     admin), a v2 sai;
//   - v2 da v2: "(v3)", nunca "(v2) (v3)";
//   - falha ao criar a v2 (cota de documentos da organização zerada no banco): a troca é desfeita, nada fica
//     `SUPERSEDED` sem sucessora;
//   - falha ao enviar a v2 (destinatário fora dos domínios, no banco): erro claro, a v2 fica rascunho `APPROVED` com a
//     reserva solta, nenhum aviso sai (não há link para dar), e `defineAccount` na v2 envia depois de corrigido, e só
//     então sai o aviso, com o link de assinatura da v2;
//   - troca que morreu no meio (queda entre marcar a antiga e ligar a nova): 409 dentro do prazo, retomada depois;
//   - nova versão apagada pelo dono: o cartão do Financeiro na antiga oferece "Trocar conta" de novo (sem o link para a
//     v2 apagada), e a troca acontece.
//
// Sessões: REVSIGN_USER_* (admin@hml.local, dono do REVSIGN_API_TOKEN, fora do Financeiro) e REVSIGN_ADMIN_* (rsadmin,
// ADMIN, marcado como Financeiro). Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

import {
  APP_CONTAINER,
  api,
  assertNoPaidGeminiCalls,
  BASE_URL,
  completeWithCode,
  computeEmailCode,
  createEnvelope,
  db,
  distribute,
  fetchIdempotent,
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
const GATE_MESSAGE = 'Este documento foi substituído por uma nova versão (conta contábil alterada).';
const REASON = 'Conta de serviço, não de material.';
const FROM = '2.1.03 – Fornecedores';
const TO = '3.1.01 – Serviços de terceiros';
const NOTICE_SUBJECT = (title) => `Conta contábil da nota fiscal alterada pelo Financeiro: ${title}`;
// Texto exato do aviso (global-constraints). O motivo que já termina com ponto não ganha outro.
const NOTICE = (title, reason = REASON) =>
  `A conta contábil da nota fiscal ${title} foi alterada pelo Financeiro de ${FROM} para ${TO}. Motivo: ${reason}`;

const ACCOUNTS = [
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
];
const INACTIVE = '9.9.98';

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-financeiro-troca-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userCookie;
let adminCookie;
let adminId;
let userId;

const data = (res) => res.body?.result?.data?.json;
const change = (envelopeId, { code = '3.1.01', reason = REASON, cookie = adminCookie } = {}) =>
  trpcAs(cookie, 'mutation', 'revalle.finance.changeAccount', { envelopeId, code, reason });
const one = (sql) => db(sql);
const status = (envelopeId) => one(`select status from "Envelope" where id = '${envelopeId}'`);
const financeStatus = (envelopeId) =>
  one(
    `select coalesce("financeStatus"::text, '-') from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );
const auditCount = (envelopeId, type) =>
  Number(one(`select count(*) from "DocumentAuditLog" where "envelopeId" = '${envelopeId}' and type = '${type}'`));
const successors = (envelopeId) =>
  one(`select "envelopeId" from "RevalleInvoiceClassification" where "previousEnvelopeId" = '${envelopeId}'`)
    .split('\n')
    .filter(Boolean);
const sealJobs = (documentId) =>
  one(
    `select status from "BackgroundJob" where "jobId" = 'internal.seal-document' and payload->>'documentId' = '${documentId}' order by "submittedAt"`,
  )
    .split('\n')
    .filter(Boolean);
const itemData = (envelopeId) =>
  one(`select "documentDataId" from "EnvelopeItem" where "envelopeId" = '${envelopeId}' order by "order" limit 1`);

const mailsTo = async (to) =>
  (await fetchIdempotent(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`, {}, (res) => res.json()))
    .messages ?? [];
const mailBody = (id) => fetchIdempotent(`${MAILPIT}/message/${id}`, {}, (res) => res.json());
const flat = (text) => (text ?? '').replace(/\s+/g, ' ');

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

// Convite de uma versão: o e-mail ao destinatário com o link do token dela (o aviso da troca também leva o link, mas
// não é o convite).
const waitInvite = async (email, token, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;

  do {
    for (const mail of await mailsTo(email)) {
      if (!mail.Subject.startsWith(NOTICE_SUBJECT('')) && (await mailBody(mail.ID)).Text?.includes(`/sign/${token}`)) {
        return true;
      }
    }

    await sleep(1000);
  } while (Date.now() < deadline);

  return false;
};

const waitStatus = async (envelopeId, wanted, attempts = 45) => {
  for (let i = 0; i < attempts && status(envelopeId) !== wanted; i += 1) {
    await sleep(2000);
  }

  return status(envelopeId);
};

const importAccounts = async (lines) => {
  const res = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', {
    csv: ['numero;nome;descricao;tipo', ...lines].join('\n'),
  });

  assert.equal(res.status, 200, res.text);
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
    `Referência do teste: financeiro troca ${variant} ${RUN}`,
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

// Lê uma versão do banco: destinatários (com token) e campos, como a tela de assinatura usa.
const loadVersion = (envelopeId) => {
  const [secondaryId, title] = one(`select "secondaryId" || '|' || title from "Envelope" where id = '${envelopeId}'`)
    .split(/\|(.*)/s)
    .slice(0, 2);
  const recipients = one(
    `select id || '|' || token || '|' || email || '|' || role || '|' || coalesce("signingOrder"::text, '-') from "Recipient" where "envelopeId" = '${envelopeId}' order by email`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, token, email, role, signingOrder] = line.split('|');

      return { id: Number(id), token, email, role, signingOrder };
    });
  const fields = one(
    `select f.id || '|' || f."recipientId" || '|' || f.type || '|' || f.page || '|' || f."positionX" || '|' || f."positionY" || '|' || f.width || '|' || f.height || '|' || r.email from "Field" f join "Recipient" r on r.id = f."recipientId" where f."envelopeId" = '${envelopeId}' order by r.email, f.type`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, recipientId, type, page, x, y, width, height, email] = line.split('|');

      return {
        id: Number(id),
        recipientId: Number(recipientId),
        type,
        layout: [type, page, x, y, width, height, email],
      };
    });

  return {
    id: envelopeId,
    title,
    documentId: Number.parseInt(secondaryId.split('_')[1], 10),
    recipients,
    fields,
  };
};

// Cria a NF com a conta 2.1.03, envia pela API v2 (dono = usuário comum) e devolve a versão lida do banco.
const newInvoice = async (label, { signers = 2, meta, sequential = false } = {}) => {
  const emails = Array.from({ length: signers }, (_, index) => `f6-troca-${label}-${index + 1}-${RUN}@revalle.com.br`);
  const title = `[TESTE NF] financeiro troca ${label} ${RUN}`;
  const pdf = await danfe(label);
  const recipients = emails.map((email, index) => (sequential ? { email, signingOrder: index + 1 } : { email }));
  const created = await retryCreateOnStaleSocket(() => createEnvelope({ recipients, pdf, title, meta }));

  assert.equal(created.status, 200, created.text);

  const chosen = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
    envelopeId: created.id,
    choice: { code: '2.1.03' },
  });

  assert.equal(chosen.status, 200, chosen.text);
  assert.equal((await distribute(created.id)).length, signers);
  assert.equal(financeStatus(created.id), 'PENDING_APPROVAL');

  const doc = loadVersion(created.id);

  // Com convite por e-mail, esperar por ele antes de assinar: ele não pode chegar depois do código por e-mail (o código
  // é lido do e-mail mais recente).
  if (meta?.distributionMethod === 'EMAIL') {
    for (const recipient of doc.recipients) {
      assert.ok(await waitInvite(recipient.email, recipient.token), `convite não chegou para ${recipient.email}`);
    }
  }

  return doc;
};

const gate = async (token) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

const signField = (doc, index) => {
  const recipient = doc.recipients[index];
  const field = doc.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');

  return trpc('envelope.field.sign', {
    token: recipient.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Teste Digitado' },
  });
};

// Portão, assinatura e conclusão com o código, como a tela faz.
const sign = async (doc, index) => {
  const recipient = doc.recipients[index];

  await gate(recipient.token);

  const signed = await signField(doc, index);

  assert.equal(signed.status, 200, signed.text);

  const completion = await completeWithCode({
    token: recipient.token,
    documentId: doc.documentId,
    email: recipient.email,
  });

  assert.ok(completion.ok, completion.text);
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
};

// Roda um job como o cron do app (linha PENDING em "BackgroundJob" + POST assinado; a assinatura sai do container).
const runJobLikeTheApp = async ({ jobId, name, version, payload }) => {
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
  const id = `revsign-test-${jobId}-${RUN}-${Date.now()}`;

  db(
    `insert into "BackgroundJob" (id, "jobId", name, version, payload, "updatedAt") values ('${id}', '${jobId}', '${name}', '${version}', '${JSON.stringify(payload)}', now())`,
  );

  const res = await fetch(`${BASE_URL}/api/jobs/${jobId}/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Job-Id': id, 'X-Job-Signature': signature },
    body: JSON.stringify(options),
  });

  assert.equal(res.status, 200, `job ${jobId}: HTTP ${res.status} ${await res.text()}`);

  return one(`select status from "BackgroundJob" where id = '${id}'`);
};

const errorOf = (res) => res.body?.error?.json ?? {};
const defineAccount = (envelopeId, code) =>
  trpcAs(adminCookie, 'mutation', 'revalle.finance.defineAccount', { envelopeId, code });

const changed = (res) => {
  assert.equal(res.status, 200, res.text);

  const newEnvelopeId = data(res)?.newEnvelopeId;

  assert.ok(newEnvelopeId, res.text);

  return newEnvelopeId;
};

const assertRefusedWithGateMessage = (res, label) => {
  assert.ok(!res.ok, `${label}: a ação na versão substituída foi aceita (${res.status})`);
  assert.ok(res.text.includes(GATE_MESSAGE), `${label}: sem a mensagem do portão: ${res.text.slice(0, 400)}`);
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
  adminId = Number(one(`select id from "User" where email = '${admin.email}'`));
  userId = Number(one(`select id from "User" where email = '${user.email}'`));

  const marked = await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', {
    userId: adminId,
    member: true,
  });

  assert.equal(marked.status, 200, marked.text);
  db(`delete from "RevalleFinanceMember" where "userId" = ${userId}`);

  // A 9.9.98 entra e sai da lista: fica inativa.
  await importAccounts([...ACCOUNTS, `${INACTIVE};Conta desativada do teste;Saiu da lista;pagar`]);
  await importAccounts(ACCOUNTS);
  db(`delete from "RateLimit" where action like 'revalle.invoice%'`);
});

let main;
let mainV2;

sessionTest(
  'troca com 1 dos 2 já assinado: antiga SUPERSEDED e escondida, link antigo recusado com a mensagem do portão; v2 enviada; avisos e convites',
  async () => {
    main = await newInvoice('principal', { meta: { distributionMethod: 'EMAIL' } });

    await sign(main, 0);
    // O 2º signatário está com a página aberta: já passou pelo portão.
    await gate(main.recipients[1].token);

    const res = await change(main.id);

    mainV2 = changed(res);

    // Versão antiga: substituída, com quem/quando/motivo/ligação; continua PENDING no upstream, mas escondida.
    assert.equal(financeStatus(main.id), 'SUPERSEDED');
    assert.equal(
      one(
        `select "supersededById" || '|' || "supersedeReason" || '|' || "supersededByEnvelopeId" || '|' || ("supersededAt" is not null) || '|' || "choiceCode" from "RevalleInvoiceClassification" where "envelopeId" = '${main.id}'`,
      ),
      `${adminId}|${REASON}|${mainV2}|true|2.1.03`,
    );
    assert.equal(status(main.id), 'PENDING');
    assert.equal(one(`select "deletedAt" is not null from "Envelope" where id = '${main.id}'`), 't');
    assert.equal(
      one(`select count(*) from "Recipient" where "envelopeId" = '${main.id}' and "documentDeletedAt" is null`),
      '0',
    );
    assert.equal(auditCount(main.id, 'DOCUMENT_DELETED'), 0, 'a versão antiga foi excluída como pelo upstream');

    // O 2º signatário, com a página aberta, tenta agir: tudo recusado com a mensagem do portão.
    const old = main.recipients[1];

    assertRefusedWithGateMessage(await signField(main, 1), 'assinar o campo');
    assertRefusedWithGateMessage(
      await trpc('document.accessAuth.request2FAEmail', { token: old.token }),
      'pedir o código',
    );
    assertRefusedWithGateMessage(
      await trpc('recipient.completeDocumentWithToken', {
        token: old.token,
        documentId: main.documentId,
        accessAuthOptions: {
          type: 'TWO_FACTOR_AUTH',
          method: 'email',
          token: computeEmailCode({ email: old.email, envelopeId: main.id }),
        },
      }),
      'concluir',
    );
    assertRefusedWithGateMessage(
      await trpc('recipient.rejectDocumentWithToken', { token: old.token, documentId: main.documentId, reason: 'x' }),
      'recusar',
    );
    assertRefusedWithGateMessage(
      await trpc('revalle.gate.acceptTerm', { token: old.token, termVersion: '1' }),
      'aceitar o termo',
    );

    for (const recipient of main.recipients) {
      const page = await fetchIdempotent(`${BASE_URL}/sign/${recipient.token}`, {}, async (r) => r.text());

      assert.ok(page.includes(GATE_MESSAGE), `a página do link antigo (${recipient.email}) não mostra a mensagem`);
    }

    assert.equal(
      one(`select "signingStatus" from "Recipient" where id = ${old.id}`),
      'NOT_SIGNED',
      'a versão antiga foi assinada',
    );

    // v2: mesmo dono, título "(v2)", mesmos destinatários (papel e ordem) e campos, conta nova aprovada, enviada.
    const v2 = loadVersion(mainV2);

    assert.equal(v2.title, `${main.title} (v2)`);
    assert.equal(
      one(`select "userId" || '|' || "teamId" from "Envelope" where id = '${mainV2}'`),
      one(`select "userId" || '|' || "teamId" from "Envelope" where id = '${main.id}'`),
    );
    assert.deepEqual(
      v2.recipients.map((r) => [r.email, r.role, r.signingOrder]),
      main.recipients.map((r) => [r.email, r.role, r.signingOrder]),
    );
    assert.deepEqual(
      v2.fields.map((f) => f.layout),
      main.fields.map((f) => f.layout),
    );
    assert.equal(await waitStatus(mainV2, 'PENDING', 10), 'PENDING');
    assert.equal(
      one(
        `select "isInvoice" || '|' || "choiceCode" || '|' || "choiceDefer" || '|' || "financeStatus" || '|' || "approvedById" || '|' || ("approvedAt" is not null) || '|' || version || '|' || "previousEnvelopeId" from "RevalleInvoiceClassification" where "envelopeId" = '${mainV2}'`,
      ),
      `YES|3.1.01|false|APPROVED|${adminId}|true|2|${main.id}`,
    );
    assert.equal(one(`select "deletedAt" is null from "Envelope" where id = '${mainV2}'`), 't');
    assert.equal(auditCount(mainV2, 'DOCUMENT_SENT'), 1);

    // Evento nas duas versões, com a ligação entre elas.
    for (const [envelopeId, other] of [
      [main.id, mainV2],
      [mainV2, main.id],
    ]) {
      assert.equal(
        one(
          `select data->>'fromCode' || '|' || (data->>'toCode') || '|' || (data->>'reason') || '|' || (data->>'otherEnvelopeId') from "DocumentAuditLog" where "envelopeId" = '${envelopeId}' and type = 'REVALLE_FINANCE_ACCOUNT_CHANGED'`,
        ),
        `2.1.03|3.1.01|${REASON}|${other}`,
      );
    }

    // Aviso (texto exato, com o motivo) para o remetente e os 2 signatários; convites da v2 para os 2. O botão leva
    // cada um aonde ele entra: quem assina, ao próprio link da v2; o remetente, à página da NF (ele tem conta).
    const targets = [
      [user.email, `/notas-fiscais/${mainV2}`],
      ...v2.recipients.map((recipient) => [recipient.email, `/sign/${recipient.token}`]),
    ];

    for (const [to, link] of targets) {
      const notices = await waitMails(to, (m) => m.Subject === NOTICE_SUBJECT(main.title));

      assert.equal(notices.length, 1, `aviso para ${to}`);

      const body = await mailBody(notices[0].ID);

      assert.ok(flat(body.Text).includes(NOTICE(main.title)), flat(body.Text));
      assert.ok(body.Text.includes(link), `aviso para ${to} sem o link ${link}: ${flat(body.Text)}`);
      assert.ok(!flat(body.Text).includes('o convite chega em outro e-mail'), 'o aviso promete um convite');
    }

    for (const recipient of v2.recipients) {
      const [notice] = await waitMails(recipient.email, (m) => m.Subject === NOTICE_SUBJECT(main.title));
      const body = await mailBody(notice.ID);

      assert.ok(
        !body.Text.includes('/notas-fiscais/'),
        `o aviso de quem assina leva à página da NF: ${recipient.email}`,
      );
    }

    for (const recipient of v2.recipients) {
      assert.ok(
        await waitInvite(recipient.email, recipient.token),
        `o convite da v2 não chegou para ${recipient.email}`,
      );
    }

    // A versão antiga foi escondida sem o e-mail de cancelamento do upstream ("Documento cancelado").
    for (const recipient of main.recipients) {
      const cancelled = (await mailsTo(recipient.email)).filter((m) => /cancel/i.test(m.Subject));

      assert.deepEqual(
        cancelled.map((m) => m.Subject),
        [],
        `e-mail de cancelamento para ${recipient.email}`,
      );
    }
  },
);

sessionTest('os dois assinam a v2: ela é selada (a conta nova já vale como aprovada)', async () => {
  assert.ok(mainV2, 'depende do primeiro caso');

  const v2 = loadVersion(mainV2);

  await sign(v2, 0);
  await sign(v2, 1);

  assert.equal(await waitStatus(mainV2, 'COMPLETED'), 'COMPLETED');
  assert.equal(financeStatus(mainV2), 'APPROVED');
  assert.equal(status(main.id), 'PENDING', 'a versão antiga foi concluída');
});

sessionTest('validação: motivo, mesma conta, conta inativa e estados que não cabem = 400; 403; 401; 404', async () => {
  const doc = await newInvoice('validacao', { signers: 1 });

  for (const reason of ['curto', '   abc      ', 'x'.repeat(501)]) {
    const res = await change(doc.id, { reason });

    assert.equal(res.status, 400, `motivo "${reason.slice(0, 10)}": ${res.text}`);
  }

  // 9 caracteres depois do trim: o limite vale depois do trim (com os espaços seriam 15).
  assert.equal((await change(doc.id, { reason: '   123456789   ' })).status, 400);

  const same = await change(doc.id, { code: '2.1.03' });

  assert.equal(same.status, 400, same.text);

  const inactive = await change(doc.id, { code: INACTIVE });

  assert.equal(inactive.status, 400, inactive.text);

  const missing = await change(doc.id, { code: '0.0.00' });

  assert.equal(missing.status, 400, missing.text);

  const outsider = await change(doc.id, { cookie: userCookie });

  assert.equal(outsider.status, 403, outsider.text);

  const anonymous = await trpc('revalle.finance.changeAccount', { envelopeId: doc.id, code: '3.1.01', reason: REASON });

  assert.equal(anonymous.status, 401, anonymous.text);
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
  assert.deepEqual(successors(doc.id), []);

  // Documento comum (não é NF): 404.
  const common = await retryCreateOnStaleSocket(() =>
    createEnvelope({ recipients: [{ email: `f6-troca-comum-${RUN}@revalle.com.br` }], title: `[TESTE] troca ${RUN}` }),
  );

  assert.equal(common.status, 200, common.text);
  await distribute(common.id);
  assert.equal((await change(common.id)).status, 404);

  // Rascunho (com conta), NF retida aguardando a conta, NF LEGACY pendente e versão já substituída: 400.
  const draft = await retryCreateOnStaleSocket(() =>
    createEnvelope({
      recipients: [{ email: `f6-troca-rascunho-${RUN}@revalle.com.br` }],
      pdf: path.join(tmp, 'danfe-validacao.pdf'),
      title: `[TESTE NF] financeiro troca rascunho ${RUN}`,
    }),
  );

  assert.equal(draft.status, 200, draft.text);
  assert.equal(
    (
      await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
        envelopeId: draft.id,
        choice: { code: '2.1.03' },
      })
    ).status,
    200,
  );
  assert.equal((await change(draft.id)).status, 400);

  db(
    `update "RevalleInvoiceClassification" set "financeStatus" = 'AWAITING_ACCOUNT', "choiceCode" = null, "choiceDefer" = true where "envelopeId" = '${draft.id}'`,
  );
  assert.equal((await change(draft.id)).status, 400);

  const legacy = await newInvoice('legacy-pendente', { signers: 1 });

  db(`update "RevalleInvoiceClassification" set "financeStatus" = 'LEGACY' where "envelopeId" = '${legacy.id}'`);
  assert.equal((await change(legacy.id)).status, 400);
  assert.deepEqual(successors(legacy.id), []);

  assert.ok(main, 'depende do primeiro caso');
  assert.equal((await change(main.id, { code: '2.1.03' })).status, 400, 'versão já substituída');
  assert.deepEqual(successors(main.id), [mainV2]);
});

sessionTest('duas trocas ao mesmo tempo (clique duplo): exatamente 1 v2', async () => {
  const doc = await newInvoice('concorrente', { signers: 1 });
  const results = await Promise.all([change(doc.id), change(doc.id)]);

  const texts = results.map((r) => r.text).join('\n');

  // Um vence (200); o outro recebe 4xx (já substituída / em andamento), nunca 5xx nem uma segunda versão.
  assert.equal(results.filter((r) => r.status === 200).length, 1, texts);
  assert.ok(
    results.every((r) => r.status === 200 || (r.status >= 400 && r.status < 500)),
    texts,
  );
  assert.equal(successors(doc.id).length, 1);
  assert.equal(
    one(`select count(*) from "Envelope" where title = '${doc.title.replaceAll("'", "''")} (v2)'`),
    '1',
    'mais de uma v2 criada',
  );
  assert.equal(auditCount(doc.id, 'REVALLE_FINANCE_ACCOUNT_CHANGED'), 1);
  assert.equal(financeStatus(doc.id), 'SUPERSEDED');
});

sessionTest('NF já concluída: a antiga continua COMPLETED (visível) e SUPERSEDED; a v2 é enviada', async () => {
  const doc = await newInvoice('concluida', { signers: 1 });
  const approved = await trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', { envelopeId: doc.id });

  assert.equal(approved.status, 200, approved.text);
  await sign(doc, 0);
  assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');

  const v2 = changed(await change(doc.id));

  assert.equal(status(doc.id), 'COMPLETED');
  assert.equal(financeStatus(doc.id), 'SUPERSEDED');
  assert.equal(one(`select "deletedAt" is null from "Envelope" where id = '${doc.id}'`), 't');
  assert.equal(
    one(`select count(*) from "Recipient" where "envelopeId" = '${doc.id}' and "documentDeletedAt" is not null`),
    '0',
  );
  assert.equal(await waitStatus(v2, 'PENDING', 10), 'PENDING');
  assert.equal(financeStatus(v2), 'APPROVED');
});

sessionTest(
  'NF retida (todos assinaram, aguardando aprovação): a antiga fica PENDING e nunca é selada (varredura, reselagem); v2 enviada',
  async () => {
    const doc = await newInvoice('retida');

    await sign(doc, 0);
    await sign(doc, 1);
    await sleep(2000);
    assert.equal(status(doc.id), 'PENDING');

    const v2 = changed(await change(doc.id));

    assert.equal(await waitStatus(v2, 'PENDING', 10), 'PENDING');
    assert.equal(status(doc.id), 'PENDING');
    assert.equal(financeStatus(doc.id), 'SUPERSEDED');

    // A varredura de verdade (o que foi assinado entre 15 minutos e 6 horas atrás) não sela a antiga.
    db(`update "Recipient" set "signedAt" = now() - interval '20 minutes' where "envelopeId" = '${doc.id}'`);

    const swept = await runJobLikeTheApp({
      jobId: 'internal.seal-document-sweep',
      name: 'Seal Document Sweep',
      version: '1.0.0',
      payload: {},
    });

    assert.equal(swept, 'COMPLETED');
    await sleep(2000);
    assert.deepEqual(sealJobs(doc.documentId), [], 'a varredura disparou a selagem da versão substituída');

    // Reselagem pelo admin: o job roda e sai sem selar.
    const beforeData = itemData(doc.id);
    const resealed = await trpcAs(adminCookie, 'mutation', 'admin.document.reseal', { id: doc.id });

    assert.ok(resealed.ok, resealed.text);

    for (let i = 0; i < 30 && sealJobs(doc.documentId).at(-1) !== 'COMPLETED'; i += 1) {
      await sleep(1000);
    }

    assert.deepEqual(sealJobs(doc.documentId), ['COMPLETED'], 'o job de selagem falhou ou não rodou');
    assert.equal(status(doc.id), 'PENDING');
    assert.equal(itemData(doc.id), beforeData, 'a versão substituída foi selada');
    assert.equal(auditCount(doc.id, 'DOCUMENT_COMPLETED'), 0);
  },
);

sessionTest('v2 da v2: o título vira "(v3)", nunca "(v2) (v3)"', async () => {
  const doc = await newInvoice('v3', { signers: 1 });
  const v2 = changed(await change(doc.id));
  const v3 = changed(await change(v2, { code: '2.1.03', reason: 'Era material mesmo, voltando a conta.' }));

  assert.equal(loadVersion(v3).title, `${doc.title} (v3)`);
  assert.equal(
    one(
      `select version || '|' || "previousEnvelopeId" || '|' || "choiceCode" from "RevalleInvoiceClassification" where "envelopeId" = '${v3}'`,
    ),
    `3|${v2}|2.1.03`,
  );
  assert.equal(financeStatus(v2), 'SUPERSEDED');
  assert.equal(
    one(`select "supersededByEnvelopeId" from "RevalleInvoiceClassification" where "envelopeId" = '${v2}'`),
    v3,
  );
});

sessionTest('falha ao criar a v2 (cota zerada): a troca é desfeita, nada fica SUPERSEDED sem sucessora', async () => {
  const doc = await newInvoice('cota', { signers: 1 });
  const claimId = one(
    `select o."organisationClaimId" from "Envelope" e join "Team" t on t.id = e."teamId" join "Organisation" o on o.id = t."organisationId" where e.id = '${doc.id}'`,
  );
  const previousQuota = one(
    `select coalesce("documentQuota"::text, 'null') from "OrganisationClaim" where id = '${claimId}'`,
  );

  db(`update "OrganisationClaim" set "documentQuota" = 0 where id = '${claimId}'`);

  try {
    const res = await change(doc.id);

    assert.ok(!res.ok, `a troca passou com a cota zerada: ${res.text}`);
  } finally {
    db(`update "OrganisationClaim" set "documentQuota" = ${previousQuota} where id = '${claimId}'`);
  }

  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
  assert.equal(
    one(
      `select ("supersededAt" is null) || '|' || ("supersededById" is null) || '|' || ("supersedeReason" is null) || '|' || ("supersededByEnvelopeId" is null) from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`,
    ),
    'true|true|true|true',
  );
  assert.equal(one(`select "deletedAt" is null from "Envelope" where id = '${doc.id}'`), 't');
  assert.deepEqual(successors(doc.id), []);
  assert.equal(auditCount(doc.id, 'REVALLE_FINANCE_ACCOUNT_CHANGED'), 0);

  // O link continua valendo e, de novo com a cota, a troca acontece.
  const page = await fetchIdempotent(`${BASE_URL}/sign/${doc.recipients[0].token}`, {}, async (r) => r.text());

  assert.ok(!page.includes(GATE_MESSAGE));
  changed(await change(doc.id));
});

// Troca cujo envio da v2 é recusado (destinatário de fora dos domínios, posto no banco): 409 claro e a v2 em rascunho.
const changeWithFailedSend = async (label) => {
  const doc = await newInvoice(label, { signers: 1 });

  db(`update "Recipient" set email = 'f6-troca-fora-${label}-${RUN}@example.com' where "envelopeId" = '${doc.id}'`);

  const res = await change(doc.id);

  assert.equal(res.status, 409, res.text);
  assert.equal(errorOf(res).data?.code, 'FINANCE_NEW_VERSION_NOT_SENT', res.text);
  assert.ok(
    errorOf(res).message?.startsWith(
      `A conta foi trocada e a nova versão "${doc.title} (v2)" foi criada, mas não foi enviada: `,
    ),
    res.text,
  );
  assert.ok(
    errorOf(res).message?.endsWith(
      '. O remetente pode corrigir o rascunho e enviá-lo, ou o Financeiro envia de novo (mesma conta) depois da correção.',
    ),
    res.text,
  );

  const [v2] = successors(doc.id);

  assert.ok(v2, 'a v2 não ficou criada');
  assert.equal(status(v2), 'DRAFT');
  assert.equal(released(v2), 'APPROVED|3.1.01|true');
  assert.equal(financeStatus(doc.id), 'SUPERSEDED');
  assert.equal(
    one(`select "supersededByEnvelopeId" from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`),
    v2,
  );

  return { doc, v2 };
};

const released = (envelopeId) =>
  one(
    `select "financeStatus" || '|' || "choiceCode" || '|' || ("approvedAt" is null) from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );

sessionTest(
  'falha ao enviar a v2: 409 claro; defineAccount só reenvia a mesma conta e uma 2ª falha não apaga a conta; corrigida, envia',
  async () => {
    const { doc, v2 } = await changeWithFailedSend('envio-falha');

    // Sem a v2 enviada não há link nem convite: o aviso da troca ainda não sai.
    await sleep(3000);
    assert.deepEqual(
      (await mailsTo(user.email)).filter((m) => m.Subject === NOTICE_SUBJECT(doc.title)),
      [],
      'o aviso saiu antes da nova versão ser enviada',
    );

    const other = await defineAccount(v2, '2.1.03');

    assert.equal(other.status, 400, other.text);
    assert.equal(
      errorOf(other).message,
      'Esta versão já tem a conta definida pela troca. Envie-a e, se precisar, use Trocar conta.',
    );

    // 2ª falha (o destinatário continua de fora): a v2 continua aprovada com a conta e a reserva solta.
    const again = await defineAccount(v2, '3.1.01');

    assert.ok(again.status >= 400 && again.status < 500, again.text);
    assert.equal(status(v2), 'DRAFT');
    assert.equal(released(v2), 'APPROVED|3.1.01|true');

    db(`update "Recipient" set email = 'f6-troca-corrigido-${RUN}@revalle.com.br' where "envelopeId" = '${v2}'`);

    const retried = await defineAccount(v2, '3.1.01');

    assert.equal(retried.status, 200, retried.text);
    assert.deepEqual(data(retried), { sent: true });
    assert.equal(await waitStatus(v2, 'PENDING', 10), 'PENDING');
    assert.equal(released(v2), 'APPROVED|3.1.01|false');

    // Enviada a v2, o aviso sai (uma vez): o remetente com a página da NF, quem assina com o link da v2.
    const signer = loadVersion(v2).recipients[0];
    const [ownerNotice] = await waitMails(user.email, (m) => m.Subject === NOTICE_SUBJECT(doc.title));

    assert.ok(ownerNotice, 'o aviso não saiu depois do envio da nova versão');
    assert.ok((await mailBody(ownerNotice.ID)).Text.includes(`/notas-fiscais/${v2}`));

    const [signerNotice] = await waitMails(signer.email, (m) => m.Subject === NOTICE_SUBJECT(doc.title));

    assert.ok(signerNotice, 'o aviso não chegou para quem assina a nova versão');
    assert.ok((await mailBody(signerNotice.ID)).Text.includes(`/sign/${signer.token}`));
    await sleep(2000);
    assert.equal((await mailsTo(user.email)).filter((m) => m.Subject === NOTICE_SUBJECT(doc.title)).length, 1);
  },
);

sessionTest(
  'falha ao enviar a v2: o remetente corrige o rascunho e envia; a aprovação fica com a data da troca',
  async () => {
    const { v2 } = await changeWithFailedSend('envio-falha-dono');
    const state = await trpcAs(userCookie, 'query', 'revalle.invoice.get', { envelopeId: v2 });

    assert.equal(state.status, 200, state.text);
    assert.equal(data(state)?.isFinanceSendReleased, true, 'o bloco do envio não libera o rascunho');

    db(`update "Recipient" set email = 'f6-troca-dono-${RUN}@revalle.com.br' where "envelopeId" = '${v2}'`);

    const sent = await api('POST', '/envelope/distribute', { envelopeId: v2 });

    assert.equal(sent.status, 200, sent.text);
    assert.equal(await waitStatus(v2, 'PENDING', 10), 'PENDING');
    assert.equal(
      one(
        `select "financeStatus" || '|' || ("approvedAt" = "choiceAt") || '|' || ("approvedById" = ${adminId}) from "RevalleInvoiceClassification" where "envelopeId" = '${v2}'`,
      ),
      'APPROVED|true|true',
    );
  },
);

sessionTest(
  'troca que morreu no meio (marca SUPERSEDED sem sucessora, no banco): 409 dentro do prazo; depois, outra troca retoma',
  async () => {
    const doc = await newInvoice('retomada', { signers: 1 });
    const mark = (age) =>
      db(
        `update "RevalleInvoiceClassification" set "financeStatus" = 'SUPERSEDED', "supersededAt" = now() - interval '${age}', "supersededById" = ${adminId}, "supersedeReason" = 'Queda no meio da troca.' where "envelopeId" = '${doc.id}'`,
      );

    mark('10 seconds');

    const early = await change(doc.id);

    assert.equal(early.status, 409, early.text);
    assert.deepEqual(successors(doc.id), []);

    mark('10 minutes');

    const v2 = changed(await change(doc.id));

    assert.deepEqual(successors(doc.id), [v2]);
    assert.equal(
      one(
        `select "supersedeReason" || '|' || "supersededByEnvelopeId" from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`,
      ),
      `${REASON}|${v2}`,
    );
    assert.equal(await waitStatus(v2, 'PENDING', 10), 'PENDING');
  },
);

const financeCard = async (envelopeId) => {
  const res = await trpcAs(adminCookie, 'query', 'revalle.finance.get', { envelopeId });

  assert.equal(res.status, 200, res.text);

  return data(res);
};

sessionTest(
  'nova versão apagada pelo dono: o cartão oferece "Trocar conta" de novo e a troca retoma a antiga',
  async () => {
    const doc = await newInvoice('sucessora-apagada', { signers: 1 });
    const first = changed(await change(doc.id));

    assert.equal(await waitStatus(first, 'PENDING', 10), 'PENDING');

    const linked = await financeCard(doc.id);

    assert.equal(linked.supersededByEnvelopeId, first);
    assert.equal(linked.canRetakeChange, false);

    // O dono apaga a v2 pendente (exclusão do upstream: some do banco).
    const deleted = await api('POST', '/envelope/delete', { envelopeId: first });

    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(one(`select count(*) from "Envelope" where id = '${first}'`), '0');

    const orphan = await financeCard(doc.id);

    assert.equal(orphan.financeStatus, 'SUPERSEDED');
    assert.equal(orphan.canRetakeChange, true, 'o cartão não oferece trocar de novo');
    assert.equal(orphan.supersededByEnvelopeId, null, 'o cartão ainda aponta para a versão apagada');

    const page = await fetchIdempotent(
      `${BASE_URL}/notas-fiscais/${doc.id}`,
      { headers: { Cookie: adminCookie } },
      async (r) => r.text(),
    );

    assert.ok(!page.includes(`/notas-fiscais/${first}`), 'a página da NF ainda leva à versão apagada');

    const second = changed(await change(doc.id));

    assert.notEqual(second, first);
    assert.deepEqual(successors(doc.id), [second]);
    assert.equal(
      one(`select "supersededByEnvelopeId" from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`),
      second,
    );
    assert.equal(await waitStatus(second, 'PENDING', 10), 'PENDING');
  },
);

sessionTest('recusada, excluída ou com o dono desativado: 400, nada muda', async () => {
  const rejected = await newInvoice('recusada', { signers: 1 });

  await gate(rejected.recipients[0].token);

  const refused = await trpc('recipient.rejectDocumentWithToken', {
    token: rejected.recipients[0].token,
    documentId: rejected.documentId,
    reason: 'Teste',
  });

  assert.equal(refused.status, 200, refused.text);
  assert.equal((await change(rejected.id)).status, 400);
  assert.deepEqual(successors(rejected.id), []);

  const deleted = await newInvoice('excluida', { signers: 1 });

  db(`update "Envelope" set "deletedAt" = now() where id = '${deleted.id}'`);
  assert.equal((await change(deleted.id)).status, 400);
  assert.equal(financeStatus(deleted.id), 'PENDING_APPROVAL');

  const disabledOwner = await newInvoice('dono-desativado', { signers: 1 });
  let res;

  db(`update "User" set disabled = true where id = ${userId}`);

  try {
    res = await change(disabledOwner.id);
  } finally {
    db(`update "User" set disabled = false where id = ${userId}`);
  }

  assert.equal(res.status, 400, res.text);
  assert.ok(errorOf(res).message?.includes('O dono do documento está desativado'), res.text);
  assert.equal(financeStatus(disabledOwner.id), 'PENDING_APPROVAL');
  assert.deepEqual(successors(disabledOwner.id), []);
});

sessionTest(
  'a v2 leva as configurações (idioma, ordem SEQUENTIAL, expiração, lembretes); os prazos da antiga são zerados',
  async () => {
    const doc = await newInvoice('configuracoes', {
      sequential: true,
      meta: {
        language: 'en',
        signingOrder: 'SEQUENTIAL',
        envelopeExpirationPeriod: { unit: 'week', amount: 2 },
        reminderSettings: { sendAfter: { unit: 'day', amount: 3 }, repeatEvery: { unit: 'day', amount: 1 } },
      },
    });
    const metaOf = (envelopeId) =>
      one(
        `select m.language || '|' || m."signingOrder" || '|' || m."envelopeExpirationPeriod"::text || '|' || m."reminderSettings"::text from "DocumentMeta" m join "Envelope" e on e."documentMetaId" = m.id where e.id = '${envelopeId}'`,
      );
    const withExpiry = (envelopeId) =>
      Number(
        one(
          `select count(*) from "Recipient" where "envelopeId" = '${envelopeId}' and "signingStatus" = 'NOT_SIGNED' and "expiresAt" is not null`,
        ),
      );

    assert.ok(metaOf(doc.id).startsWith('en|SEQUENTIAL|'), metaOf(doc.id));
    assert.ok(withExpiry(doc.id) > 0, 'o envio não deu prazo aos destinatários (o caso não provaria nada)');

    const v2 = changed(await change(doc.id));

    assert.equal(metaOf(v2), metaOf(doc.id));
    assert.deepEqual(
      loadVersion(v2).recipients.map((r) => [r.email, r.signingOrder]),
      doc.recipients.map((r) => [r.email, r.signingOrder]),
    );
    assert.deepEqual(
      doc.recipients.map((r) => r.signingOrder),
      ['1', '2'],
    );
    assert.equal(withExpiry(doc.id), 0, 'a versão antiga ficou com prazo de expiração');
  },
);
