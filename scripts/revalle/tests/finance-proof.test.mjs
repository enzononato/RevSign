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
//     sem nenhum código nem o id da nova versão.
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
const BLOCK = (code, name) => `Nota fiscal · Conta contábil: ${code} – ${name}`;
const SIGNER_ROW = (code) => `Conta contábil vista ao assinar: ${code}`;
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

// Cria a NF com a conta 2.1.03, envia pela API v2 e devolve a versão lida do banco.
const newInvoice = async (label, { signers = 2 } = {}) => {
  const emails = Array.from({ length: signers }, (_, index) => `f6-prova-${label}-${index + 1}-${RUN}@revalle.com.br`);
  const title = `[TESTE NF] financeiro prova ${label} ${RUN}`;
  const pdf = await danfe(label);
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({ recipients: emails.map((email) => ({ email })), pdf, title }),
  );

  assert.equal(created.status, 200, created.text);

  const chosen = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
    envelopeId: created.id,
    choice: { code: '2.1.03' },
  });

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

  const chosen = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
    envelopeId: body.envelopeId,
    choice: { code: '2.1.03' },
  });

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

// Portão, assinatura e conclusão com o código, como a tela faz.
const sign = async (doc, index) => {
  const recipient = doc.recipients[index];

  await gate(recipient.token);

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
    assert.equal(await waitStatus(common.id, 'COMPLETED'), 'COMPLETED');

    const plain = await sealedText(common);

    assert.ok(plain.includes('Certificado de Assinatura'), 'documento comum sem o certificado');
    assert.ok(!/conta cont[aá]bil/i.test(plain), 'documento comum com linha de conta contábil');

    const done = await html(`/sign/${common.recipients[0].token}/complete`);

    assert.ok(!done.text.includes(WAITING), 'documento comum esperando o Financeiro');

    db('delete from "RateLimit"');

    const plainVerify = await html(`/verificar?codigo=${encodeURIComponent(codeOf(common.recipients[0].id))}`);

    assert.ok(!plainVerify.text.includes('Conta contábil'), '/verificar de documento comum com conta');
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

    const newCode = codeOf(v2.recipients[0].id);
    const at = brasiliaColumn('supersededAt', nf.id);

    db('delete from "RateLimit"');

    const verify = await html(`/verificar?codigo=${encodeURIComponent(codeOf(nf.recipients[0].id))}`);

    assert.equal(verify.status, 200);
    assert.ok(verify.text.includes(nf.title), '/verificar da versão antiga não achou o documento');
    assert.ok(verify.text.includes(SUPERSEDED(at)), `/verificar sem "${SUPERSEDED(at)}"`);
    assert.ok(verify.text.includes('Conta contábil: 2.1.03 – Fornecedores'), '/verificar sem a conta da versão antiga');
    assert.ok(!verify.text.includes(newCode), 'o código da nova versão aparece no /verificar da antiga');
    assert.ok(!verify.text.includes(v2.id), 'o id da nova versão aparece no /verificar da antiga');
    assert.ok(!verify.text.includes('3.1.01'), 'a conta da nova versão aparece no /verificar da antiga');
  },
);
