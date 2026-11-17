// Fase 9, Task 7: várias notas no mesmo envio. O que é assinado é, por documento, o que a página mostrou a quem assina.
//   - a página de assinatura (depois do portão) mostra a conta e o centro do documento aberto, com a frase do envio
//     acima ("Este envio tem 3 notas fiscais..."); o portão guarda, por nota, os códigos mostrados (`invoiceShown`);
//   - a prova congela, por nota, a conta e o centro vistos (`invoiceDocuments`), sem o boleto; as colunas de uma nota
//     (`invoiceAccount`, `invoiceCostCenter`) ficam nulas; quem assina sem abrir a página fica sem as notas na prova;
//   - aprovadas as três notas pelo Financeiro e selado, o certificado tem uma linha de conta e uma de centro por nota
//     ("Nota 2 de 3 (nf-b.pdf): …") e, em cada signatário que viu, "Centro de custo visto ao assinar (nota 2 de 3)";
//   - o /verificar mostra um bloco por nota ("Nota 1 de 3 · nf-a.pdf"); a versão substituída pela troca da conta da nota
//     2 diz "(conta contábil alterada na nota 2 de 3)".
// Com uma nota, tudo como antes: `finance-proof`, `certificate`, `verify-page` e `acceptance-f4` continuam valendo.
//
// Depende da aprovação e da troca de conta por nota (Task 6: `revalle.finance.approve` e `changeAccount` com
// `envelopeItemId`). A IA não é usada aqui (a conta e o centro são escolhidos à mão); sem chamada ao Gemini de verdade.
//
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN, escolhe as contas) e REVSIGN_ADMIN_* (rsadmin, marcado como
// Financeiro aqui, importa a lista de contas). Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, beforeEach, test } from 'node:test';

import './account-autologin.mjs'; // conta obrigatória (16/11/2026): entra na conta de quem assina pelo e-mail da empresa
import {
  api,
  assertNoPaidGeminiCalls,
  BASE_URL,
  completeWithCode,
  db,
  downloadItem,
  fetchIdempotent,
  invoicePdfFile,
  poppler,
  retryCreateOnStaleSocket,
  signIn,
  textPdfBuffer,
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

// As três notas do envio: arquivo, conta e centro.
const NOTES = [
  { title: 'nf-a.pdf', code: '2.1.03', name: 'Fornecedores', center: '101', centerName: 'Puxada' },
  { title: 'nf-b.pdf', code: '3.1.01', name: 'Serviços de terceiros', center: '201', centerName: 'Armazém' },
  { title: 'nf-c.pdf', code: '2.1.03', name: 'Fornecedores', center: '301', centerName: 'Administrativo' },
];

// Textos exatos (plano da Fase 9, Task 7).
const BLOCK = (note) =>
  `Nota fiscal · Conta contábil: ${note.code} – ${note.name} · Centro de custo: ${note.center} – ${note.centerName}`;
const ENVELOPE_SENTENCE = 'Este envio tem 3 notas fiscais.';
const ENVELOPE_SENTENCE_FULL =
  'Este envio tem 3 notas fiscais. A conta e o centro de custo de cada uma aparecem no documento dela.';
const DOCUMENT_ACCOUNT_LINE = (k, note, approver, at) =>
  `Nota ${k} de 3 (${note.title}): Conta contábil: ${note.code} – ${note.name} · aprovada pelo Financeiro (${approver}) em ${at} (horário de Brasília)`;
const DOCUMENT_CENTER_LINE = (k, note) =>
  `Nota ${k} de 3 (${note.title}): Centro de custo: ${note.center} – ${note.centerName}`;
const SIGNER_ACCOUNT_ROW = (k, code) => `Conta contábil vista ao assinar (nota ${k} de 3): ${code}`;
const SIGNER_CENTER_ROW = (k, code) => `Centro de custo visto ao assinar (nota ${k} de 3): ${code}`;
const VERIFY_TITLE = (k, note) => `Nota ${k} de 3 · ${note.title}`;
const SUPERSEDED = (at) => `Substituído por uma nova versão em ${at} (conta contábil alterada na nota 2 de 3)`;

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-prova-varias-notas-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userCookie;
let adminCookie;
const fx = {};

const data = (res) => res.body?.result?.data?.json;
const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);
const financeStatus = (envelopeId) =>
  db(
    `select coalesce("financeStatus"::text, '-') from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );
const proofColumn = (recipientId, column) =>
  JSON.parse(
    db(`select coalesce("${column}"::text, 'null') from "RevalleSignatureProof" where "recipientId" = ${recipientId}`),
  );
const codeOf = (recipientId) =>
  db(`select "verificationCode" from "RevalleSignatureProof" where "recipientId" = ${recipientId}`);
const invoiceShownOf = (recipientId) =>
  JSON.parse(
    db(
      `select coalesce("invoiceShown"::text, 'null') from "RevalleRecipientGate" where "recipientId" = ${recipientId}`,
    ),
  );
// dd/MM/yyyy HH:mm em Brasília, direto do banco (as colunas são UTC sem fuso).
const brasilia = (column) =>
  `to_char(("${column}" at time zone 'UTC') at time zone 'America/Bahia', 'DD/MM/YYYY HH24:MI')`;

const waitStatus = async (envelopeId, wanted, attempts = 45) => {
  for (let i = 0; i < attempts && status(envelopeId) !== wanted; i += 1) {
    await sleep(2000);
  }

  return status(envelopeId);
};

const html = (route) =>
  fetchIdempotent(`${BASE_URL}${route}`, {}, async (res) => ({ status: res.status, text: await res.text() }));

// Boleto fictício (sem DANFE nem "nota fiscal" no texto): nunca vira nota.
const boletoFile = () => {
  const file = path.join(mkdtempSync(path.join(tmp, 'b-')), 'boleto.pdf');

  writeFileSync(
    file,
    textPdfBuffer([
      'Banco Ficticio S.A.   Recibo do Pagador',
      'Beneficiario: Distribuidora Ficticia Ltda',
      'Vencimento: 30/12/2026   Valor do Documento: R$ 600,00',
      'Linha digitavel: 00190.00009 01234.567004 00000.000000 1 00000000060000',
      `Referencia do teste: boleto ${RUN}`,
    ]),
  );

  return file;
};

// Envio (API v2) com as três notas e o boleto, um campo de assinatura de cada signatário em cada arquivo (o envio
// exige); conta e centro escolhidos à mão em cada nota; enviado. Devolve a versão lida do banco.
const newMultiInvoice = async (label, { signers = 2 } = {}) => {
  const files = [
    ...NOTES.map((note) =>
      invoicePdfFile({ variant: note.title.replace('.pdf', ''), extraLines: [`${label} ${RUN}`] }),
    ),
    boletoFile(),
  ];
  const title = `[TESTE NF] prova várias notas ${label} ${RUN}`;
  const emails = Array.from({ length: signers }, (_, index) => `f9-prova-${label}-${index + 1}-${RUN}@revalle.com.br`);
  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title,
      type: 'DOCUMENT',
      meta: { distributionMethod: 'NONE' },
      recipients: emails.map((email) => ({
        role: 'SIGNER',
        name: 'Teste',
        email,
        fields: files.map((_, identifier) => ({
          type: 'SIGNATURE',
          identifier,
          page: 1,
          positionX: 10,
          positionY: 80,
          width: 30,
          height: 8,
        })),
      })),
    }),
  );

  for (const file of files) {
    form.append('files', new File([readFileSync(file)], path.basename(file), { type: 'application/pdf' }));
  }

  const created = await retryCreateOnStaleSocket(async () => {
    const res = await fetch(`${BASE_URL}/api/v2-beta/envelope/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` },
      body: form,
    });

    return { status: res.status, body: await res.json() };
  });

  assert.equal(created.status, 200, JSON.stringify(created.body));

  const envelopeId = created.body.id;
  const classified = await trpcAs(userCookie, 'mutation', 'revalle.invoice.classify', { envelopeId });

  assert.equal(classified.status, 200, classified.text);
  assert.deepEqual(
    data(classified).documents.map((doc) => doc.kind === 'NF'),
    [true, true, true, false],
    'as três notas viram NF e o boleto não',
  );

  const items = loadItems(envelopeId);

  for (const note of NOTES) {
    const envelopeItemId = items[note.title];
    const account = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
      envelopeId,
      envelopeItemId,
      choice: { code: note.code },
    });

    assert.equal(account.status, 200, account.text);

    const center = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setCostCenter', {
      envelopeId,
      envelopeItemId,
      code: note.center,
    });

    assert.equal(center.status, 200, center.text);
  }

  const sent = await api('POST', '/envelope/distribute', { envelopeId });

  assert.equal(sent.status, 200, sent.text);
  assert.equal(financeStatus(envelopeId), 'PENDING_APPROVAL');

  return loadVersion(envelopeId);
};

const loadItems = (envelopeId) =>
  Object.fromEntries(
    db(`select title || '|' || id from "EnvelopeItem" where "envelopeId" = '${envelopeId}' order by "order"`)
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('|')),
  );

// Uma versão do banco: os arquivos (título → id), os destinatários (com token) e os campos de assinatura de cada um.
const loadVersion = (envelopeId) => {
  const [secondaryId, title] = db(`select "secondaryId" || '|' || title from "Envelope" where id = '${envelopeId}'`)
    .split(/\|(.*)/s)
    .slice(0, 2);
  const recipients = db(
    `select r.id || '|' || r.token || '|' || r.email || '|' || coalesce((select string_agg(f.id::text, ',' order by f.id) from "Field" f where f."recipientId" = r.id and f.type = 'SIGNATURE'), '') from "Recipient" r where r."envelopeId" = '${envelopeId}' order by r.email`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, token, email, fieldIds] = line.split('|');

      return { id: Number(id), token, email, fieldIds: fieldIds.split(',').filter(Boolean).map(Number) };
    });

  return {
    id: envelopeId,
    title,
    documentId: Number.parseInt(secondaryId.split('_')[1], 10),
    items: loadItems(envelopeId),
    recipients,
  };
};

const gate = async (token) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

// Portão, a página de assinatura (que mostra as notas), a assinatura em cada arquivo e a conclusão com o código.
// `openPage: false` = assinatura sem a página do RevSign (como pelo embed). `preGated` = portão e página já feitos.
const sign = async (doc, index, { openPage = true, preGated = false } = {}) => {
  const recipient = doc.recipients[index];

  if (!preGated) {
    await gate(recipient.token);

    if (openPage) {
      assert.equal((await html(`/sign/${recipient.token}`)).status, 200);
    }
  }

  assert.equal(recipient.fieldIds.length, 4, 'um campo de assinatura por arquivo');

  for (const fieldId of recipient.fieldIds) {
    const signed = await trpc('envelope.field.sign', {
      token: recipient.token,
      fieldId,
      fieldValue: { type: 'SIGNATURE', value: 'Teste Digitado' },
    });

    assert.equal(signed.status, 200, signed.text);
  }

  const completion = await completeWithCode({
    token: recipient.token,
    documentId: doc.documentId,
    email: recipient.email,
  });

  assert.ok(completion.ok, completion.text);
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
};

// Texto do PDF selado de um arquivo (documento, certificado e log), com os espaços normalizados.
const sealedText = async (itemId) => {
  const dir = mkdtempSync(path.join(tmp, 'selado-'));

  writeFileSync(path.join(dir, 'signed.pdf'), await downloadItem(itemId, 'signed'));

  return poppler(dir, 'pdftotext /pdf/signed.pdf -').replace(/\s+/g, ' ');
};

const count = (text, piece) => text.split(piece).length - 1;

const approve = (envelopeId, envelopeItemId) =>
  trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', { envelopeId, envelopeItemId });

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
  const marked = await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', {
    userId: adminId,
    member: true,
  });

  assert.equal(marked.status, 200, marked.text);

  const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });

  assert.equal(imported.status, 200, imported.text);
  db(`delete from "RateLimit" where action like 'revalle.invoice%'`);
});

beforeEach(() => {
  db('delete from "RateLimit"');
});

sessionTest('a página de assinatura mostra a conta e o centro do documento aberto', async () => {
  // Três signatários: o 1º e o 2º assinam pela página; o 3º, sem abrir a página (caso mais abaixo).
  const doc = await newMultiInvoice('pagina', { signers: 3 });

  fx.doc = doc;

  const token = doc.recipients[0].token;
  const beforeGate = await html(`/sign/${token}`);

  assert.equal(beforeGate.status, 200);
  assert.ok(!beforeGate.text.includes('Conta contábil'), 'a conta aparece antes do portão');
  assert.ok(!beforeGate.text.includes(ENVELOPE_SENTENCE), 'a frase do envio aparece antes do portão');

  await gate(token);

  const page = await html(`/sign/${token}`);

  assert.equal(page.status, 200);
  assert.ok(page.text.includes(doc.title), 'a página de assinatura não abriu o documento');
  // O documento aberto é o primeiro (nf-a): a frase dele, e não a das outras notas.
  assert.ok(page.text.includes(BLOCK(NOTES[0])), `sem "${BLOCK(NOTES[0])}"`);
  assert.ok(!page.text.includes(BLOCK(NOTES[1])), 'a frase da nota 2 aparece com a nota 1 aberta');
  assert.ok(page.text.includes(ENVELOPE_SENTENCE_FULL), `sem "${ENVELOPE_SENTENCE_FULL}"`);

  const shown = invoiceShownOf(doc.recipients[0].id);

  assert.deepEqual(
    shown,
    Object.fromEntries(
      NOTES.map((note) => [doc.items[note.title], { accountCode: note.code, costCenterCode: note.center }]),
    ),
  );
  assert.ok(!(doc.items['boleto.pdf'] in shown), 'o boleto entrou no que a página mostrou');
  assert.equal(
    db(
      `select coalesce("invoiceAccountShownCode", '-') || '|' || coalesce("invoiceCostCenterShownCode", '-') from "RevalleRecipientGate" where "recipientId" = ${doc.recipients[0].id}`,
    ),
    '-|-',
    'as colunas de uma nota ficam nulas com várias notas',
  );
});

sessionTest('a prova guarda, por documento, a conta e o centro vistos', async () => {
  assert.ok(fx.doc, 'depende do caso da página');

  const doc = fx.doc;

  await sign(doc, 0, { preGated: true });
  await sign(doc, 1);

  for (const recipient of doc.recipients.slice(0, 2)) {
    assert.deepEqual(
      proofColumn(recipient.id, 'invoiceDocuments'),
      NOTES.map((note, i) => ({
        envelopeItemId: doc.items[note.title],
        title: note.title,
        index: i + 1,
        total: 3,
        account: { code: note.code, name: note.name },
        costCenter: { code: note.center, name: note.centerName },
      })),
    );
    assert.equal(proofColumn(recipient.id, 'invoiceAccount'), null);
    assert.equal(proofColumn(recipient.id, 'invoiceCostCenter'), null);
  }
});

sessionTest('quem assina sem abrir a página fica sem as notas na prova', async () => {
  assert.ok(fx.doc, 'depende do caso da página');

  const doc = fx.doc;

  await sign(doc, 2, { openPage: false });
  assert.equal(proofColumn(doc.recipients[2].id, 'invoiceDocuments'), null);
  assert.equal(proofColumn(doc.recipients[2].id, 'invoiceAccount'), null);
  assert.equal(proofColumn(doc.recipients[2].id, 'invoiceCostCenter'), null);
  // Todos assinaram: falta só o Financeiro.
  assert.equal(status(doc.id), 'PENDING');
});

sessionTest('certificado com uma linha por nota', async () => {
  assert.ok(fx.doc, 'depende do caso da página');

  const doc = fx.doc;

  for (const note of NOTES) {
    const approved = await approve(doc.id, doc.items[note.title]);

    assert.equal(approved.status, 200, approved.text);
  }

  assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');

  const approvals = NOTES.map((note) =>
    db(
      `select coalesce(f."approvedByName", nullif(trim(u.name), ''), 'Financeiro') || '|' || ${brasilia('approvedAt')} from "RevalleInvoiceFile" f left join "User" u on u.id = f."approvedById" where f."envelopeItemId" = '${doc.items[note.title]}'`,
    ).split('|'),
  );

  for (const title of ['nf-a.pdf', 'boleto.pdf']) {
    const text = await sealedText(doc.items[title]);
    const where = text.slice(
      text.indexOf('Certificado de Assinatura'),
      text.indexOf('Certificado de Assinatura') + 2500,
    );

    assert.ok(text.includes('Certificado de Assinatura'), `${title}: sem o certificado`);

    // O certificado de cada arquivo selado lista todas as notas do envio.
    NOTES.forEach((note, i) => {
      const [approver, at] = approvals[i];

      assert.ok(
        text.includes(DOCUMENT_ACCOUNT_LINE(i + 1, note, approver, at)),
        `${title}: sem a linha da conta da nota ${i + 1}: ${where}`,
      );
      assert.ok(text.includes(DOCUMENT_CENTER_LINE(i + 1, note)), `${title}: sem a linha do centro da nota ${i + 1}`);
      // Só os dois que abriram a página têm as linhas "vista/visto ao assinar".
      assert.equal(count(text, SIGNER_ACCOUNT_ROW(i + 1, note.code)), 2, `${title}: conta vista (nota ${i + 1})`);
      assert.equal(count(text, SIGNER_CENTER_ROW(i + 1, note.center)), 2, `${title}: centro visto (nota ${i + 1})`);
    });

    assert.ok(text.includes(DOCUMENT_CENTER_LINE(2, NOTES[1])), 'sem "Nota 2 de 3 (nf-b.pdf): Centro de custo: 201"');
    assert.ok(!/\(boleto\.pdf\): (Conta|Centro)/.test(text), `${title}: o boleto ganhou linha de nota`);
    assert.ok(!/[Nn]ota \d de 4/.test(text), `${title}: o boleto contou como nota`);
    // As linhas sem o rótulo da nota (as de uma nota só) não aparecem.
    assert.ok(!text.includes('Conta contábil vista ao assinar:'), `${title}: linha da conta sem o rótulo da nota`);
    assert.ok(!text.includes('Centro de custo visto ao assinar:'), `${title}: linha do centro sem o rótulo da nota`);
  }
});

sessionTest('/verificar lista cada nota', async () => {
  assert.ok(fx.doc, 'depende do caso da página');

  const doc = fx.doc;
  const verify = await html(`/verificar?codigo=${encodeURIComponent(codeOf(doc.recipients[0].id))}`);

  assert.equal(verify.status, 200);
  assert.ok(verify.text.includes(doc.title), '/verificar não achou o documento');

  NOTES.forEach((note, i) => {
    const [approver, at] = db(
      `select coalesce(f."approvedByName", nullif(trim(u.name), ''), 'Financeiro') || '|' || ${brasilia('approvedAt')} from "RevalleInvoiceFile" f left join "User" u on u.id = f."approvedById" where f."envelopeItemId" = '${doc.items[note.title]}'`,
    ).split('|');

    assert.ok(verify.text.includes(VERIFY_TITLE(i + 1, note)), `sem o bloco "${VERIFY_TITLE(i + 1, note)}"`);
    assert.ok(verify.text.includes(`Conta contábil: ${note.code} – ${note.name}`), `sem a conta da nota ${i + 1}`);
    assert.ok(
      verify.text.includes(`Aprovada pelo Financeiro (${approver}) em ${at} (horário de Brasília)`),
      `sem a aprovação da nota ${i + 1}`,
    );
    assert.ok(
      verify.text.includes(`Centro de custo: ${note.center} – ${note.centerName}`),
      `sem o centro da nota ${i + 1}`,
    );
  });

  assert.ok(!verify.text.includes('boleto.pdf</h3>'), 'o boleto ganhou bloco de nota');
  assert.ok(!verify.text.includes('Aguardando aprovação do Financeiro'), 'nota aprovada aguardando o Financeiro');

  // Versão substituída pela troca da conta da nota 2: o código de quem assinou a versão antiga diz em qual nota mudou,
  // e as notas continuam com a conta e o centro da versão antiga.
  const pending = await newMultiInvoice('substituida', { signers: 1 });

  await sign(pending, 0);

  const changed = await trpcAs(adminCookie, 'mutation', 'revalle.finance.changeAccount', {
    envelopeId: pending.id,
    envelopeItemId: pending.items['nf-b.pdf'],
    code: '2.1.03',
    reason: REASON,
  });

  assert.equal(changed.status, 200, changed.text);
  assert.equal(financeStatus(pending.id), 'SUPERSEDED');

  const supersededAt = db(
    `select ${brasilia('supersededAt')} from "RevalleInvoiceClassification" where "envelopeId" = '${pending.id}'`,
  );

  db('delete from "RateLimit"');

  const old = await html(`/verificar?codigo=${encodeURIComponent(codeOf(pending.recipients[0].id))}`);

  assert.equal(old.status, 200);
  assert.ok(old.text.includes(SUPERSEDED(supersededAt)), `/verificar sem "${SUPERSEDED(supersededAt)}"`);
  assert.ok(old.text.includes(VERIFY_TITLE(2, NOTES[1])), '/verificar da versão antiga sem o bloco da nota 2');
  assert.ok(
    old.text.includes(`Conta contábil: ${NOTES[1].code} – ${NOTES[1].name}`),
    '/verificar da versão antiga sem a conta antiga da nota 2',
  );
  assert.ok(!old.text.includes(data(changed).newEnvelopeId), 'o id da nova versão aparece no /verificar da antiga');
});
