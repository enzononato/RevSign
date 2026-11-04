// Fase 6, Task 5: a conta contábil faz parte do que é assinado.
//   - página de assinatura de uma NF (V2 e V1), depois do portão: "Nota fiscal · Conta contábil: {código} – {nome}";
//     antes do portão, nada da conta; num documento comum, nada;
//   - a prova congelada de cada signatário grava `invoiceAccount` ({ code, name } da conta escolhida no momento); num
//     documento comum, nula;
//   - NF retida (todos assinaram, falta a aprovação): a página de conclusão diz "Aguardando aprovação do Financeiro…";
//   - aprovada e selada: o certificado traz a linha do documento (conta, quem aprovou e quando) e, em cada signatário,
//     "Conta contábil vista ao assinar"; o /verificar mostra a conta e a aprovação; documento comum sem nada disso;
//   - versão substituída (conta trocada pelo Financeiro): a prova antiga continua com a conta antiga, a v2 grava a nova,
//     e o /verificar com o código antigo mostra "Substituído por uma nova versão em {data} (conta contábil alterada)",
//     sem nenhum código nem o id da nova versão;
//   - o nome da conta aprovada fica congelado na aprovação: depois de renomear a conta (reimportar o CSV com o mesmo
//     número) e resselar, o certificado e o /verificar continuam com o nome aprovado; o nome de quem aprovou também
//     (renomeado depois, a reselagem e o /verificar mantêm o nome da aprovação);
//   - a prova só congela a conta que a página de assinatura mostrou: quem assina sem abrir a página (como pelo embed,
//     que não mostra o bloco) ou com a página aberta antes de a conta existir (NF marcada depois do envio) fica sem a
//     conta, e o certificado sem a linha "Conta contábil vista ao assinar" dele.
//
// Fase 7, Task 4: o centro de custo faz parte do que é assinado, pela mesma regra e em separado da conta:
//   - a frase da página vira "Nota fiscal · Conta contábil: {código} – {nome} · Centro de custo: {código} – {nome}";
//     NF sem centro (marcada depois do envio) mostra a frase de antes;
//   - a prova grava `invoiceCostCenter` ({ code, name }) só se o centro é o que a página mostrou; a conta da prova não
//     leva o centro dentro;
//   - o certificado traz "Centro de custo visto ao assinar" em cada signatário e a linha do documento "Centro de custo:
//     101 – Puxada" para qualquer NF com centro, também a que conclui como `LEGACY`, e não afirma validação;
//   - o /verificar mostra "Centro de custo: …"; NF sem centro, nenhuma dessas linhas.
//
// Revisão final da Fase 7: o /verificar de NF retida diz "Aguardando aprovação do Financeiro"; o de NF recusada, não.
//
// Sessões: REVSIGN_USER_* (admin@hml.local, dono do REVSIGN_API_TOKEN, fora do Financeiro) e REVSIGN_ADMIN_* (rsadmin,
// ADMIN, marcado como Financeiro aqui). Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, beforeEach, test } from 'node:test';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

import {
  assertNoPaidGeminiCalls,
  BASE_URL,
  chooseInvoice,
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
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const REASON = 'Conta de serviço, não de material.';
const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
].join('\n');

// Textos exatos (global-constraints).
const BLOCK_NO_CENTER = (code, name) => `Nota fiscal · Conta contábil: ${code} – ${name}`;
const BLOCK = (code, name, center = '101 – Puxada') => `${BLOCK_NO_CENTER(code, name)} · Centro de custo: ${center}`;
const SIGNER_ROW = (code) => `Conta contábil vista ao assinar: ${code}`;
const CENTER_SIGNER_ROW = (code) => `Centro de custo visto ao assinar: ${code}`;
const CENTER_LINE = (label) => `Centro de custo: ${label}`;
const DOCUMENT_LINE = (code, name, approver, at) =>
  `Conta contábil: ${code} – ${name} · aprovada pelo Financeiro (${approver}) em ${at} (horário de Brasília)`;
const WAITING = 'Aguardando aprovação do Financeiro';
const WAITING_DETAIL = 'Você receberá o documento assinado por e-mail quando for aprovado.';
const SUPERSEDED = (at) => `Substituído por uma nova versão em ${at} (conta contábil alterada)`;

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-financeiro-prova-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userCookie;
let adminCookie;
let adminName;

const data = (res) => res.body?.result?.data?.json;
const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);
const financeStatus = (envelopeId) =>
  db(
    `select coalesce("financeStatus"::text, '-') from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );
// dd/MM/yyyy HH:mm em Brasília, direto do banco (as colunas são UTC sem fuso).
const brasiliaColumn = (column, envelopeId) =>
  db(
    `select to_char(("${column}" at time zone 'UTC') at time zone 'America/Bahia', 'DD/MM/YYYY HH24:MI') from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );
const proofOf = (recipientId) =>
  db(
    `select coalesce("invoiceAccount"::text, 'null') || '|' || "verificationCode" from "RevalleSignatureProof" where "recipientId" = ${recipientId}`,
  ).split('|');
const invoiceAccountOf = (recipientId) => JSON.parse(proofOf(recipientId)[0]);
const invoiceCostCenterOf = (recipientId) =>
  JSON.parse(
    db(
      `select coalesce("invoiceCostCenter"::text, 'null') from "RevalleSignatureProof" where "recipientId" = ${recipientId}`,
    ),
  );
const shownCostCenterOf = (recipientId) =>
  db(
    `select coalesce("invoiceCostCenterShownCode", '-') from "RevalleRecipientGate" where "recipientId" = ${recipientId}`,
  );
const codeOf = (recipientId) => proofOf(recipientId)[1];

const waitStatus = async (envelopeId, wanted, attempts = 45) => {
  for (let i = 0; i < attempts && status(envelopeId) !== wanted; i += 1) {
    await sleep(2000);
  }

  return status(envelopeId);
};

const html = (route) =>
  fetchIdempotent(`${BASE_URL}${route}`, {}, async (res) => ({ status: res.status, text: await res.text() }));

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
    `Referência do teste: financeiro prova ${variant} ${RUN}`,
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

// Lê uma versão do banco: destinatários (com token) e o campo de assinatura de cada um.
const loadVersion = (envelopeId) => {
  const [secondaryId, title] = db(`select "secondaryId" || '|' || title from "Envelope" where id = '${envelopeId}'`)
    .split(/\|(.*)/s)
    .slice(0, 2);
  const recipients = db(
    `select r.id || '|' || r.token || '|' || r.email || '|' || coalesce((select f.id::text from "Field" f where f."recipientId" = r.id and f.type = 'SIGNATURE' limit 1), '-') from "Recipient" r where r."envelopeId" = '${envelopeId}' order by r.email`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, token, email, fieldId] = line.split('|');

      return { id: Number(id), token, email, fieldId: Number(fieldId) };
    });

  return {
    id: envelopeId,
    title,
    documentId: Number.parseInt(secondaryId.split('_')[1], 10),
    item: db(`select id from "EnvelopeItem" where "envelopeId" = '${envelopeId}' order by "order" limit 1`),
    recipients,
  };
};

// Cria a NF com a conta 2.1.03 e o centro (101 por padrão), envia pela API v2 e devolve a versão lida do banco.
const newInvoice = async (label, { signers = 2, costCenter = '101' } = {}) => {
  const emails = Array.from({ length: signers }, (_, index) => `f6-prova-${label}-${index + 1}-${RUN}@revalle.com.br`);
  const title = `[TESTE NF] financeiro prova ${label} ${RUN}`;
  const pdf = await danfe(label);
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({ recipients: emails.map((email) => ({ email })), pdf, title }),
  );

  assert.equal(created.status, 200, created.text);

  const chosen = await chooseInvoice({ cookie: userCookie, envelopeId: created.id, costCenter });

  assert.equal(chosen.status, 200, chosen.text);
  assert.equal((await distribute(created.id)).length, signers);
  assert.equal(financeStatus(created.id), 'PENDING_APPROVAL');

  return loadVersion(created.id);
};

// Documento comum (contrato de exemplo) com 1 signatário, enviado pela API v2.
const newCommon = async (label) => {
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({
      recipients: [{ email: `f6-prova-${label}-1-${RUN}@revalle.com.br` }],
      title: `[TESTE] financeiro prova ${label} ${RUN}`,
    }),
  );

  assert.equal(created.status, 200, created.text);
  await distribute(created.id);
  assert.notEqual(
    db(`select "isInvoice" from "RevalleInvoiceClassification" where "envelopeId" = '${created.id}'`),
    'YES',
    'o contrato de exemplo virou NF',
  );

  return loadVersion(created.id);
};

// NF criada como documento v1 (`internalVersion = 1`, tela de assinatura V1): `/api/v2-beta/document/create` cria esse
// tipo de envelope com o transporte do banco (o da stack local e da produção); o envio é pela API v1.
const newV1Invoice = async (label) => {
  const title = `[TESTE NF] financeiro prova v1 ${label} ${RUN}`;
  const email = `f6-prova-${label}-1-${RUN}@revalle.com.br`;
  const file = await danfe(label);
  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title,
      meta: { distributionMethod: 'NONE' },
      recipients: [
        {
          email,
          name: 'Teste',
          role: 'SIGNER',
          fields: [{ type: 'SIGNATURE', pageNumber: 1, pageX: 10, pageY: 80, width: 30, height: 8 }],
        },
      ],
    }),
  );
  form.append('file', new File([readFileSync(file)], path.basename(file), { type: 'application/pdf' }));

  const res = await fetch(`${BASE_URL}/api/v2-beta/document/create`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` },
    body: form,
  });
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(db(`select "internalVersion" from "Envelope" where id = '${body.envelopeId}'`), '1');

  const chosen = await chooseInvoice({ cookie: userCookie, envelopeId: body.envelopeId });

  assert.equal(chosen.status, 200, chosen.text);

  const sent = await fetch(`${BASE_URL}/api/v1/documents/${body.id}/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sendEmail: false }),
  });

  assert.equal(sent.status, 200, await sent.text());

  return loadVersion(body.envelopeId);
};

const gate = async (token) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

// Portão, a página de assinatura (que mostra a conta), assinatura e conclusão com o código, como a tela faz.
// `openPage: false` = assinatura sem a página do RevSign (o embed não mostra o bloco da conta).
// `preGated: true` = o teste já passou pelo portão (e abriu a página) e muda algo antes de assinar, sem refazer o portão.
const sign = async (doc, index, { openPage = true, preGated = false } = {}) => {
  const recipient = doc.recipients[index];

  if (!preGated) {
    await gate(recipient.token);
  }

  if (openPage) {
    assert.equal((await html(`/sign/${recipient.token}`)).status, 200);
  }

  const signed = await trpc('envelope.field.sign', {
    token: recipient.token,
    fieldId: recipient.fieldId,
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

// Texto do PDF selado (documento, certificado e log), com os espaços normalizados.
const sealedText = async (doc) => {
  const dir = mkdtempSync(path.join(tmp, 'selado-'));

  writeFileSync(path.join(dir, 'signed.pdf'), await downloadItem(doc.item, 'signed'));

  return poppler(dir, 'pdftotext /pdf/signed.pdf -').replace(/\s+/g, ' ');
};

const count = (text, piece) => text.split(piece).length - 1;

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

  const adminId = Number(db(`select id from "User" where email = '${admin.email}'`));

  adminName = db(`select coalesce(nullif(trim(name), ''), email) from "User" where id = ${adminId}`);

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

beforeEach(() => {
  db('delete from "RateLimit"');
});

sessionTest(
  'assinatura: o bloco da conta na página V2 e V1 de uma NF (só depois do portão); nada em documento comum',
  async () => {
    const nf = await newInvoice('bloco', { signers: 1 });
    const token = nf.recipients[0].token;

    // Antes do portão, nada do documento (nem a conta).
    const beforeGate = await html(`/sign/${token}`);

    assert.equal(beforeGate.status, 200);
    assert.ok(!beforeGate.text.includes('Conta contábil'), 'a conta aparece antes do portão');
    assert.ok(!beforeGate.text.includes('Fornecedores'), 'o nome da conta aparece antes do portão');

    await gate(token);

    const v2 = await html(`/sign/${token}`);

    assert.equal(v2.status, 200);
    assert.ok(v2.text.includes(nf.title), 'a página de assinatura não abriu o documento');
    assert.ok(v2.text.includes(BLOCK('2.1.03', 'Fornecedores')), 'V2: sem o bloco "Nota fiscal · Conta contábil"');

    const v1Doc = await newV1Invoice('bloco-v1');

    await gate(v1Doc.recipients[0].token);

    const v1 = await html(`/sign/${v1Doc.recipients[0].token}`);

    assert.equal(v1.status, 200);
    assert.ok(v1.text.includes(v1Doc.title), 'a página de assinatura V1 não abriu o documento');
    assert.ok(v1.text.includes(BLOCK('2.1.03', 'Fornecedores')), 'V1: sem o bloco "Nota fiscal · Conta contábil"');

    const common = await newCommon('bloco-comum');

    await gate(common.recipients[0].token);

    const plain = await html(`/sign/${common.recipients[0].token}`);

    assert.equal(plain.status, 200);
    assert.ok(plain.text.includes(common.title), 'a página do documento comum não abriu');
    assert.ok(!plain.text.includes('Nota fiscal · Conta contábil'), 'documento comum com o bloco da NF');
    assert.ok(!plain.text.includes('Centro de custo'), 'documento comum com o centro de custo');
  },
);

sessionTest(
  'prova e certificado: conta congelada; retida, "Aguardando aprovação"; aprovada, as duas linhas e o /verificar',
  async () => {
    const nf = await newInvoice('certificado');

    await sign(nf, 0);
    await sign(nf, 1);

    for (const recipient of nf.recipients) {
      assert.deepEqual(invoiceAccountOf(recipient.id), { code: '2.1.03', name: 'Fornecedores' });
      assert.deepEqual(invoiceCostCenterOf(recipient.id), { code: '101', name: 'Puxada' });
    }

    // Retida: o último a assinar vê a espera pelo Financeiro (não "Processando documento").
    assert.equal(status(nf.id), 'PENDING');

    const waiting = await html(`/sign/${nf.recipients[1].token}/complete`);

    assert.equal(waiting.status, 200);
    assert.ok(waiting.text.includes(WAITING), 'sem "Aguardando aprovação do Financeiro" na conclusão');
    assert.ok(waiting.text.includes(WAITING_DETAIL), 'sem o aviso do e-mail depois da aprovação');

    const approved = await trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', { envelopeId: nf.id });

    assert.equal(approved.status, 200, approved.text);
    assert.equal(await waitStatus(nf.id, 'COMPLETED'), 'COMPLETED');

    const at = brasiliaColumn('approvedAt', nf.id);

    assert.match(at, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);

    const text = await sealedText(nf);

    assert.ok(text.includes('Certificado de Assinatura'), 'sem o certificado');
    assert.ok(
      text.includes(DOCUMENT_LINE('2.1.03', 'Fornecedores', adminName, at)),
      `sem a linha do documento: ${text.slice(text.indexOf('Certificado de Assinatura'), text.indexOf('Certificado de Assinatura') + 1500)}`,
    );
    assert.equal(count(text, SIGNER_ROW('2.1.03')), 2, 'uma linha "Conta contábil vista ao assinar" por signatário');

    db('delete from "RateLimit"');

    const verify = await html(`/verificar?codigo=${encodeURIComponent(codeOf(nf.recipients[0].id))}`);

    assert.equal(verify.status, 200);
    assert.ok(verify.text.includes('Conta contábil: 2.1.03 – Fornecedores'), '/verificar sem a conta');
    assert.ok(
      verify.text.includes(`Aprovada pelo Financeiro (${adminName}) em ${at} (horário de Brasília)`),
      '/verificar sem a aprovação',
    );

    // Documento comum: prova sem conta, nenhuma linha de conta, conclusão normal.
    const common = await newCommon('certificado-comum');

    await sign(common, 0);
    assert.equal(invoiceAccountOf(common.recipients[0].id), null);
    assert.equal(invoiceCostCenterOf(common.recipients[0].id), null);
    assert.equal(await waitStatus(common.id, 'COMPLETED'), 'COMPLETED');

    const plain = await sealedText(common);

    assert.ok(plain.includes('Certificado de Assinatura'), 'documento comum sem o certificado');
    assert.ok(!/conta cont[aá]bil/i.test(plain), 'documento comum com linha de conta contábil');
    assert.ok(!/centro de custo/i.test(plain), 'documento comum com linha de centro de custo');

    const done = await html(`/sign/${common.recipients[0].token}/complete`);

    assert.ok(!done.text.includes(WAITING), 'documento comum esperando o Financeiro');

    db('delete from "RateLimit"');

    const plainVerify = await html(`/verificar?codigo=${encodeURIComponent(codeOf(common.recipients[0].id))}`);

    assert.ok(!plainVerify.text.includes('Conta contábil'), '/verificar de documento comum com conta');
    assert.ok(!plainVerify.text.includes('Centro de custo'), '/verificar de documento comum com centro de custo');
  },
);

sessionTest(
  '/verificar: NF retida diz "Aguardando aprovação do Financeiro"; NF recusada não (a nota acabou)',
  async () => {
    // Retida: os dois assinaram e falta o Financeiro. A página pública diz que aguarda.
    const held = await newInvoice('verificar-retida');

    await sign(held, 0);
    await sign(held, 1);
    assert.equal(status(held.id), 'PENDING');
    db('delete from "RateLimit"');

    const waiting = await html(`/verificar?codigo=${encodeURIComponent(codeOf(held.recipients[0].id))}`);

    assert.equal(waiting.status, 200);
    assert.ok(waiting.text.includes(WAITING), '/verificar da NF retida sem "Aguardando aprovação do Financeiro"');

    // Recusada: o primeiro assinou (tem código) e o segundo recusou. A conta e o centro seguem aparecendo, mas a nota
    // não aguarda mais ninguém.
    const refused = await newInvoice('verificar-recusada');

    await sign(refused, 0);
    await gate(refused.recipients[1].token);

    const refusal = await trpc('recipient.rejectDocumentWithToken', {
      token: refused.recipients[1].token,
      documentId: refused.documentId,
      reason: 'Teste',
    });

    assert.equal(refusal.status, 200, refusal.text);
    assert.equal(await waitStatus(refused.id, 'REJECTED'), 'REJECTED');
    assert.equal(financeStatus(refused.id), 'PENDING_APPROVAL');
    db('delete from "RateLimit"');

    const verify = await html(`/verificar?codigo=${encodeURIComponent(codeOf(refused.recipients[0].id))}`);

    assert.equal(verify.status, 200);
    assert.ok(verify.text.includes(refused.title), '/verificar da NF recusada não achou o documento');
    assert.ok(verify.text.includes('Recusado em'), '/verificar da NF recusada sem "Recusado em"');
    assert.ok(verify.text.includes('Conta contábil: 2.1.03 – Fornecedores'), '/verificar da NF recusada sem a conta');
    assert.ok(!verify.text.includes(WAITING), '/verificar diz que a NF recusada aguarda aprovação do Financeiro');
  },
);

sessionTest(
  'versão substituída: prova antiga mantém a conta, a v2 grava a nova e o /verificar antigo diz "Substituído…"',
  async () => {
    const nf = await newInvoice('substituida');

    await sign(nf, 0);
    assert.deepEqual(invoiceAccountOf(nf.recipients[0].id), { code: '2.1.03', name: 'Fornecedores' });

    const changed = await trpcAs(adminCookie, 'mutation', 'revalle.finance.changeAccount', {
      envelopeId: nf.id,
      code: '3.1.01',
      reason: REASON,
    });

    assert.equal(changed.status, 200, changed.text);

    const v2 = loadVersion(data(changed).newEnvelopeId);

    assert.equal(financeStatus(nf.id), 'SUPERSEDED');

    // A v2 mostra a conta nova a quem assina e grava a nova na prova; a antiga continua com a antiga.
    await gate(v2.recipients[0].token);

    const page = await html(`/sign/${v2.recipients[0].token}`);

    assert.ok(page.text.includes(BLOCK('3.1.01', 'Serviços de terceiros')), 'v2 sem o bloco da conta nova');

    await sign(v2, 0);
    assert.deepEqual(invoiceAccountOf(v2.recipients[0].id), { code: '3.1.01', name: 'Serviços de terceiros' });
    assert.deepEqual(invoiceAccountOf(nf.recipients[0].id), { code: '2.1.03', name: 'Fornecedores' });
    // A v2 leva o centro da antiga (a troca de conta não mexe nele) e as duas provas guardam o centro visto.
    assert.deepEqual(invoiceCostCenterOf(v2.recipients[0].id), { code: '101', name: 'Puxada' });
    assert.deepEqual(invoiceCostCenterOf(nf.recipients[0].id), { code: '101', name: 'Puxada' });

    const newCode = codeOf(v2.recipients[0].id);
    const at = brasiliaColumn('supersededAt', nf.id);

    db('delete from "RateLimit"');

    const verify = await html(`/verificar?codigo=${encodeURIComponent(codeOf(nf.recipients[0].id))}`);

    assert.equal(verify.status, 200);
    assert.ok(verify.text.includes(nf.title), '/verificar da versão antiga não achou o documento');
    assert.ok(verify.text.includes(SUPERSEDED(at)), `/verificar sem "${SUPERSEDED(at)}"`);
    assert.ok(verify.text.includes('Conta contábil: 2.1.03 – Fornecedores'), '/verificar sem a conta da versão antiga');
    assert.ok(verify.text.includes(CENTER_LINE('101 – Puxada')), '/verificar sem o centro da versão antiga');
    assert.ok(!verify.text.includes(newCode), 'o código da nova versão aparece no /verificar da antiga');
    assert.ok(!verify.text.includes(v2.id), 'o id da nova versão aparece no /verificar da antiga');
    assert.ok(!verify.text.includes('3.1.01'), 'a conta da nova versão aparece no /verificar da antiga');
  },
);

sessionTest(
  'nome da conta e de quem aprovou congelados na aprovação: renomeados depois, a reselagem e o /verificar mantêm os nomes',
  async () => {
    const RENAMED = 'Fornecedores Renomeados Depois';
    const RENAMED_APPROVER = 'Aprovador Renomeado Depois';
    const approverName = db(`select coalesce(name, '') from "User" where email = '${admin.email}'`);
    const nf = await newInvoice('nome-congelado', { signers: 1 });

    await sign(nf, 0);

    const approved = await trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', { envelopeId: nf.id });

    assert.equal(approved.status, 200, approved.text);
    assert.equal(await waitStatus(nf.id, 'COMPLETED'), 'COMPLETED');

    const at = brasiliaColumn('approvedAt', nf.id);
    const itemData = () => db(`select "documentDataId" from "EnvelopeItem" where id = '${nf.item}'`);
    const sealedBefore = itemData();

    try {
      const renamed = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', {
        csv: ACCOUNTS_CSV.replace('2.1.03;Fornecedores;', `2.1.03;${RENAMED};`),
      });

      assert.equal(renamed.status, 200, renamed.text);
      assert.equal(db(`select name from "RevalleAccountingAccount" where code = '2.1.03'`), RENAMED);
      db(`update "User" set name = '${RENAMED_APPROVER}' where email = '${admin.email}'`);

      const resealed = await trpcAs(adminCookie, 'mutation', 'admin.document.reseal', { id: nf.id });

      assert.ok(resealed.ok, resealed.text);

      for (let i = 0; i < 45 && itemData() === sealedBefore; i += 1) {
        await sleep(1000);
      }

      assert.notEqual(itemData(), sealedBefore, 'a reselagem não gerou um PDF novo');

      const text = await sealedText(nf);

      assert.ok(
        text.includes(DOCUMENT_LINE('2.1.03', 'Fornecedores', adminName, at)),
        'a reselagem perdeu o nome aprovado da conta',
      );
      assert.ok(!text.includes(RENAMED), 'o certificado usou o nome novo da conta');
      assert.ok(!text.includes(RENAMED_APPROVER), 'o certificado usou o nome novo de quem aprovou');

      db('delete from "RateLimit"');

      const verify = await html(`/verificar?codigo=${encodeURIComponent(codeOf(nf.recipients[0].id))}`);

      assert.ok(verify.text.includes('Conta contábil: 2.1.03 – Fornecedores'), '/verificar sem o nome aprovado');
      assert.ok(!verify.text.includes(RENAMED), '/verificar com o nome novo da conta');
      assert.ok(
        verify.text.includes(`Aprovada pelo Financeiro (${adminName}) em ${at}`),
        '/verificar sem o nome de quem aprovou na aprovação',
      );
      assert.ok(!verify.text.includes(RENAMED_APPROVER), '/verificar com o nome novo de quem aprovou');
    } finally {
      db(`update "User" set name = '${approverName.replace(/'/g, "''")}' where email = '${admin.email}'`);
      await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });
    }
  },
);

sessionTest(
  'a prova só congela a conta mostrada: sem a página (embed) ou com a página aberta antes da conta, sem a linha da conta',
  async () => {
    const nf = await newInvoice('sem-pagina');

    // O 1º assina sem a página do RevSign (como pelo embed); o 2º, pela página, que mostra a conta.
    await sign(nf, 0, { openPage: false });
    await sign(nf, 1);
    assert.equal(invoiceAccountOf(nf.recipients[0].id), null, 'a prova afirma uma conta que a pessoa não viu');
    assert.equal(invoiceCostCenterOf(nf.recipients[0].id), null, 'a prova afirma um centro que a pessoa não viu');
    assert.deepEqual(invoiceAccountOf(nf.recipients[1].id), { code: '2.1.03', name: 'Fornecedores' });
    assert.deepEqual(invoiceCostCenterOf(nf.recipients[1].id), { code: '101', name: 'Puxada' });

    const approved = await trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', { envelopeId: nf.id });

    assert.equal(approved.status, 200, approved.text);
    assert.equal(await waitStatus(nf.id, 'COMPLETED'), 'COMPLETED');
    const partial = await sealedText(nf);

    assert.equal(count(partial, SIGNER_ROW('2.1.03')), 1, 'só quem viu a conta tem a linha');
    assert.equal(count(partial, CENTER_SIGNER_ROW('101')), 1, 'só quem viu o centro tem a linha');

    // NF marcada depois do envio: a página abriu sem conta, o dono escolheu a conta e a pessoa assinou sem recarregar.
    const late = await newCommon('conta-depois');
    const token = late.recipients[0].token;

    await gate(token);

    const before = await html(`/sign/${token}`);

    assert.ok(!before.text.includes('Nota fiscal · Conta contábil'), 'a página mostrou uma conta que não existia');
    assert.equal(
      (await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: late.id })).status,
      200,
    );
    assert.equal(
      (
        await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
          envelopeId: late.id,
          choice: { code: '2.1.03' },
        })
      ).status,
      200,
    );

    await sign(late, 0, { openPage: false });
    assert.equal(invoiceAccountOf(late.recipients[0].id), null, 'a prova afirma a conta escolhida depois');
    assert.equal(invoiceCostCenterOf(late.recipients[0].id), null);
  },
);

sessionTest(
  'centro de custo 201: a frase da página, a prova, o certificado (signatário e documento) e o /verificar',
  async () => {
    const nf = await newInvoice('centro', { costCenter: '201' });
    const first = nf.recipients[0];

    // Antes do portão, nada do centro; depois, a frase inteira num só nó de texto.
    const beforeGate = await html(`/sign/${first.token}`);

    assert.equal(beforeGate.status, 200);
    assert.ok(!beforeGate.text.includes('Centro de custo'), 'o centro aparece antes do portão');
    assert.ok(!beforeGate.text.includes('Armazém'), 'o nome do centro aparece antes do portão');

    await gate(first.token);

    const page = await html(`/sign/${first.token}`);

    assert.ok(
      page.text.includes(BLOCK('2.1.03', 'Fornecedores', '201 – Armazém')),
      'a página não mostrou a conta e o centro na mesma frase',
    );
    assert.equal(shownCostCenterOf(first.id), '201', 'o portão não registrou o centro mostrado');

    await sign(nf, 0, { openPage: false, preGated: true });
    await sign(nf, 1);

    for (const recipient of nf.recipients) {
      assert.deepEqual(invoiceCostCenterOf(recipient.id), { code: '201', name: 'Armazém' });
      // O centro é uma coluna própria: a conta da prova continua só { code, name }.
      assert.deepEqual(invoiceAccountOf(recipient.id), { code: '2.1.03', name: 'Fornecedores' });
    }

    const approved = await trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', { envelopeId: nf.id });

    assert.equal(approved.status, 200, approved.text);
    assert.equal(await waitStatus(nf.id, 'COMPLETED'), 'COMPLETED');

    const text = await sealedText(nf);

    assert.ok(text.includes('Certificado de Assinatura'), 'sem o certificado');
    assert.equal(
      count(text, CENTER_SIGNER_ROW('201')),
      2,
      'uma linha "Centro de custo visto ao assinar" por signatário',
    );
    assert.ok(text.includes(CENTER_LINE('201 – Armazém')), 'sem a linha do documento com o centro');
    assert.ok(!text.includes('Contabilidade'), 'o certificado afirma algo da Contabilidade');

    db('delete from "RateLimit"');

    const verify = await html(`/verificar?codigo=${encodeURIComponent(codeOf(first.id))}`);

    assert.equal(verify.status, 200);
    assert.ok(verify.text.includes(CENTER_LINE('201 – Armazém')), '/verificar sem o centro');
    assert.ok(!verify.text.includes('Contabilidade'), '/verificar afirma algo da Contabilidade');
  },
);

// NF marcada depois do envio: o dono escolhe a conta e a página abre só com ela (`withCenterAfterPage` define o centro
// depois que a página abriu e antes de a pessoa assinar). Aprovada pelo Financeiro e selada.
const signLateInvoice = async (label, { withCenterAfterPage = null } = {}) => {
  const late = await newCommon(label);
  const recipient = late.recipients[0];

  assert.equal(
    (await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: late.id })).status,
    200,
  );
  assert.equal((await chooseInvoice({ cookie: userCookie, envelopeId: late.id, costCenter: null })).status, 200);

  await gate(recipient.token);

  const page = await html(`/sign/${recipient.token}`);

  assert.ok(page.text.includes(BLOCK_NO_CENTER('2.1.03', 'Fornecedores')), 'a página não mostrou a conta');
  assert.ok(!page.text.includes('Centro de custo'), 'a página mostrou um centro que a NF não tem');
  assert.equal(shownCostCenterOf(recipient.id), '-', 'o portão registrou um centro que a página não mostrou');

  if (withCenterAfterPage) {
    // Primeira escolha depois do envio, pelo dono, sem nova versão: ninguém viu esse centro ao assinar.
    assert.equal(
      (await chooseInvoice({ cookie: userCookie, envelopeId: late.id, code: null, costCenter: withCenterAfterPage }))
        .status,
      200,
    );
  }

  await sign(late, 0, { openPage: false, preGated: true });
  assert.deepEqual(invoiceAccountOf(recipient.id), { code: '2.1.03', name: 'Fornecedores' });
  assert.equal(invoiceCostCenterOf(recipient.id), null, 'a prova afirma um centro que a pessoa não viu');

  const approved = await trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', { envelopeId: late.id });

  assert.equal(approved.status, 200, approved.text);
  assert.equal(await waitStatus(late.id, 'COMPLETED'), 'COMPLETED', 'a NF sem centro não concluiu depois da aprovação');

  return late;
};

sessionTest(
  'NF marcada depois do envio, sem centro: a frase de antes, e nenhuma linha do centro na prova, no certificado nem no /verificar',
  async () => {
    const late = await signLateInvoice('sem-centro');
    const text = await sealedText(late);

    assert.ok(text.includes(SIGNER_ROW('2.1.03')), 'a conta vista ao assinar sumiu');
    assert.ok(!/centro de custo/i.test(text), 'o certificado tem linha de centro de custo numa NF sem centro');

    db('delete from "RateLimit"');

    const verify = await html(`/verificar?codigo=${encodeURIComponent(codeOf(late.recipients[0].id))}`);

    assert.ok(verify.text.includes('Conta contábil: 2.1.03 – Fornecedores'), '/verificar sem a conta');
    assert.ok(!verify.text.includes('Centro de custo'), '/verificar com centro numa NF sem centro');
  },
);

sessionTest(
  'o centro definido depois que a página abriu não entra na prova do signatário, mas a linha do documento sai',
  async () => {
    const late = await signLateInvoice('centro-depois', { withCenterAfterPage: '301' });
    const text = await sealedText(late);

    assert.ok(text.includes(SIGNER_ROW('2.1.03')), 'a conta vista ao assinar sumiu');
    assert.ok(!text.includes('Centro de custo visto ao assinar'), 'o signatário não viu o centro e tem a linha dele');
    assert.ok(text.includes(CENTER_LINE('301 – Administrativo')), 'sem a linha do documento com o centro');

    db('delete from "RateLimit"');

    const verify = await html(`/verificar?codigo=${encodeURIComponent(codeOf(late.recipients[0].id))}`);

    assert.ok(verify.text.includes(CENTER_LINE('301 – Administrativo')), '/verificar sem o centro');
  },
);

sessionTest(
  'NF LEGACY com centro: conclui sem o Financeiro e o certificado e o /verificar trazem o centro, sem a linha da conta aprovada',
  async () => {
    const nf = await newInvoice('legacy', { signers: 1, costCenter: '301' });

    db(`update "RevalleInvoiceClassification" set "financeStatus" = 'LEGACY' where "envelopeId" = '${nf.id}'`);

    await sign(nf, 0);
    assert.equal(await waitStatus(nf.id, 'COMPLETED'), 'COMPLETED', 'a NF LEGACY esperou o Financeiro');
    assert.deepEqual(invoiceCostCenterOf(nf.recipients[0].id), { code: '301', name: 'Administrativo' });

    const text = await sealedText(nf);

    assert.ok(text.includes(CENTER_LINE('301 – Administrativo')), 'sem a linha do documento com o centro');
    assert.equal(count(text, CENTER_SIGNER_ROW('301')), 1);
    assert.ok(!text.includes('aprovada pelo Financeiro'), 'a NF LEGACY ganhou a linha de aprovação');

    db('delete from "RateLimit"');

    const verify = await html(`/verificar?codigo=${encodeURIComponent(codeOf(nf.recipients[0].id))}`);

    assert.ok(verify.text.includes(CENTER_LINE('301 – Administrativo')), '/verificar sem o centro');
    assert.ok(!verify.text.includes('Aprovada pelo Financeiro'), '/verificar de NF LEGACY com aprovação');
  },
);
