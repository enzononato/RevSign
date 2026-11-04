// Aceite da Fase 7 (centro de custo, perfil Contabilidade e fluxo sem e-mail; spec 2026-11-04), de ponta a ponta, com o
// Gemini falso (sem ele, a escolha é feita na lista) e colaboradores fictícios:
//   1. o admin marca o Financeiro e a Contabilidade, contas novas criadas por `signupColaborador`;
//   2. o remetente sobe um DANFE fictício e recebe a sugestão; sem o centro o envio é recusado; ele escolhe a conta e o
//      centro 101 e envia com dois signatários; o contador da Contabilidade e o do Financeiro sobem;
//   3. a Contabilidade valida, e só a fila dela desce;
//   4. os signatários (o remetente, sem pedir CPF de novo, e uma pessoa de fora) veem o centro e assinam; a nota fica
//      retida; (4b, passo próprio, pulado sem a imagem do Playwright) o View do remetente abre o documento;
//   5. o Financeiro aprova: COMPLETED, certificado com a conta e o centro, sem falar da validação; a Contabilidade baixa o
//      PDF pela página da NF;
//   6. segunda NF: a Contabilidade corrige de 101 para 201 com motivo; o link antigo é bloqueado; todos recebem o aviso e
//      o convite;
//   7. todos assinam a v2, o Financeiro aprova e o certificado sai com 201;
//   8. nenhum e-mail ao Financeiro nem à Contabilidade em todo o fluxo: a caixa deles só tem a confirmação da conta.
//
// Sessões: REVSIGN_ADMIN_* (rsadmin, ADMIN). As demais são contas novas a cada execução, desmarcadas no fim. Ver
// revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

import {
  api,
  assertNoPaidGeminiCalls,
  BASE_URL,
  chooseInvoice,
  completeWithCode,
  createConfirmedAccount,
  createEnvelope,
  db,
  distribute,
  downloadItem,
  fetchIdempotent,
  hasPlaywrightImage,
  mailById,
  mailIdsTo,
  mailsTo,
  PLAYWRIGHT_IMAGE,
  poppler,
  retryCreateOnStaleSocket,
  runBrowserScript,
  signIn,
  trpc,
  trpcAs,
  waitNewMail,
  workflowJobs,
  workflowMails,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };
const SKIP =
  !admin.email || !admin.password
    ? 'defina REVSIGN_ADMIN_EMAIL e REVSIGN_ADMIN_PASSWORD (revalle/docs/testes.md)'
    : false;
const FAKE_URL = (process.env.REVSIGN_FAKE_GEMINI_URL ?? 'http://localhost:8787').replace(/\/$/, '');

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = `Aceite-F7-${RUN}!`;
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };

const ACCOUNT = { code: '7.7.01', name: 'Fornecedores Aceite Sete' };
const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  `${ACCOUNT.code};${ACCOUNT.name};Conta do aceite da Fase 7;pagar`,
].join('\n');
const REASON = 'O serviço foi do armazém, não da puxada.';
const PUXADA = '101 – Puxada';
const ARMAZEM = '201 – Armazém';
const GATE_MESSAGE = 'Este documento foi substituído por uma nova versão.';

// Textos exatos (spec).
const BLOCK = (center) =>
  `Nota fiscal · Conta contábil: ${ACCOUNT.code} – ${ACCOUNT.name} · Centro de custo: ${center}`;
const DOCUMENT_LINE = (approver, at) =>
  `Conta contábil: ${ACCOUNT.code} – ${ACCOUNT.name} · aprovada pelo Financeiro (${approver}) em ${at} (horário de Brasília)`;
const CENTER_SIGNER_ROW = (code) => `Centro de custo visto ao assinar: ${code}`;
const CENTER_LINE = (center) => `Centro de custo: ${center}`;
const NOTICE_SUBJECT = (title) => `Centro de custo da nota fiscal corrigido pela Contabilidade: ${title}`;
const NOTICE_LINE = `O centro de custo foi corrigido de ${PUXADA} para ${ARMAZEM}. Motivo: ${REASON}`;

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-aceite-f7-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flat = (text) => (text ?? '').replace(/\s+/g, ' ');

const fx = {};
let adminCookie;

const data = (res) => res.body?.result?.data?.json;
const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);
const invoiceColumn = (envelopeId, column) =>
  db(
    `select coalesce("${column}"::text, '-') from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );
const financeStatus = (envelopeId) => invoiceColumn(envelopeId, 'financeStatus');
const approvedAt = (envelopeId) =>
  db(
    `select to_char(("approvedAt" at time zone 'UTC') at time zone 'America/Bahia', 'DD/MM/YYYY HH24:MI') from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );
const sealJobs = (documentId) =>
  Number(
    db(
      `select count(*) from "BackgroundJob" where "jobId" = 'internal.seal-document' and payload->>'documentId' = '${documentId}'`,
    ),
  );
const pendingCounts = async (cookie) => {
  const res = await trpcAs(cookie, 'query', 'revalle.invoice.pendingCounts');

  assert.equal(res.status, 200, res.text);

  return data(res);
};
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia' }).format(new Date());
const isInQueue = async (cookie, envelopeId, filters) => {
  const res = await trpcAs(cookie, 'query', 'revalle.invoice.find', {
    from: today(),
    perPage: 100,
    page: 1,
    ...filters,
  });

  assert.equal(res.status, 200, res.text);

  return data(res).data.some((row) => row.id === envelopeId);
};

const waitStatus = async (envelopeId, wanted) => {
  for (let i = 0; i < 45 && status(envelopeId) !== wanted; i += 1) {
    await sleep(2000);
  }

  return status(envelopeId);
};

const newAccount = (label) =>
  createConfirmedAccount({
    email: `f7-aceite-${label}-${RUN}@revalle.com.br`,
    name: `Aceite F7 ${label}`,
    password: PASSWORD,
  });

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
    `Referência do teste: aceite F7 ${variant} ${RUN}`,
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

// Lê uma versão do banco: quem assina (com token e campo) e o 1º arquivo.
const loadVersion = (envelopeId) => {
  const [secondaryId, title] = db(`select "secondaryId" || '|' || title from "Envelope" where id = '${envelopeId}'`)
    .split(/\|(.*)/s)
    .slice(0, 2);
  const recipients = db(
    `select r.token || '|' || r.email || '|' || coalesce((select f.id::text from "Field" f where f."recipientId" = r.id and f.type = 'SIGNATURE' limit 1), '-') from "Recipient" r where r."envelopeId" = '${envelopeId}' order by r.email`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [token, email, fieldId] = line.split('|');

      return { token, email, fieldId: Number(fieldId) };
    });

  return {
    id: envelopeId,
    title,
    documentId: Number.parseInt(secondaryId.split('_')[1], 10),
    item: db(`select id from "EnvelopeItem" where "envelopeId" = '${envelopeId}' order by "order" limit 1`),
    recipients,
  };
};

// Rascunho do remetente, com convites por e-mail: ele e uma pessoa de fora assinam.
const newDraft = async (label) => {
  const title = `[TESTE F7] ${label} ${RUN}`;
  const pdf = await danfe(label);
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({
      title,
      pdf,
      apiToken: fx.senderToken,
      meta: { distributionMethod: 'EMAIL' },
      recipients: [fx.sender.email, fx.signerEmail].map((email, index) => ({
        email,
        name: `Signatário ${index + 1}`,
        fields: [{ type: 'SIGNATURE', page: 1, positionX: 10, positionY: 60 + index * 12, width: 30, height: 8 }],
      })),
    }),
  );

  assert.equal(created.status, 200, created.text);

  return created.id;
};

const signingPage = (token) =>
  fetchIdempotent(`${BASE_URL}/sign/${token}`, {}, async (res) => (await res.text()).replace(/<!-- -->/g, ''));

// Portão, a página de assinatura (que tem de mostrar o centro), assinatura e conclusão com o código, como a tela faz.
const sign = async (doc, email, center) => {
  const recipient = doc.recipients.find((candidate) => candidate.email === email);

  db('delete from "RateLimit"');

  const accepted = await trpc('revalle.gate.acceptTerm', { token: recipient.token, termVersion: '1' });

  assert.equal(accepted.status, 200, accepted.text);

  // Quem já tem vínculo (a conta nova, desde a confirmação do e-mail; quem já assinou a v1) não informa o CPF de novo.
  if (email === fx.signerEmail && data(accepted).status !== 'PASSED') {
    await trpc('revalle.gate.verifyIdentity', { token: recipient.token, ...MARIA });
    await trpc('revalle.gate.confirmIdentity', { token: recipient.token, isMe: true });
  } else {
    assert.equal(data(accepted).status, 'PASSED', `${email} teve de se identificar de novo`);
  }

  assert.ok((await signingPage(recipient.token)).includes(BLOCK(center)), `${email} não viu o centro ${center}`);

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
};

const sealedText = async (doc) => {
  const dir = mkdtempSync(path.join(tmp, 'selado-'));

  writeFileSync(path.join(dir, 'signed.pdf'), await downloadItem(doc.item, 'signed', { apiToken: fx.senderToken }));

  return poppler(dir, 'pdftotext /pdf/signed.pdf -').replace(/\s+/g, ' ');
};

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const fake = async (route, body) => {
  const res = await fetch(`${FAKE_URL}${route}`, { method: 'POST', body: JSON.stringify(body) });

  assert.equal(res.status, 200, `servidor falso ${route}: ${res.status}`);
};

const testStep = (name, fn) => test(name, { skip: SKIP }, fn);

before(async () => {
  if (SKIP) {
    return;
  }

  adminCookie = await signIn(admin.email, admin.password);
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);

  const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });

  assert.equal(imported.status, 200, imported.text);
  db(`delete from "RateLimit" where action like 'revalle.invoice%'`);

  fx.aiAvailable =
    data(await trpcAs(adminCookie, 'query', 'revalle.invoice.adminGetSettings')).aiStatus === 'CONFIGURED';
  fx.signerEmail = `f7-aceite-fora-${RUN}@revalle.com.br`;
  fx.finance = await newAccount('financeiro');
  fx.accountant = await newAccount('contabilidade');
  // Por último: cada cadastro solta o vínculo do cadastro anterior (mesmo CPF fictício), e o remetente assina.
  fx.sender = await newAccount('remetente');
  fx.teamId = Number(
    db(
      `select t.id from "Team" t join "Organisation" o on o.id = t."organisationId" where o."ownerUserId" = ${fx.sender.id} limit 1`,
    ),
  );
  fx.teamUrl = db(`select url from "Team" where id = ${fx.teamId}`);

  // Só o ADMIN cria token de API: o remetente comum é promovido só para esta chamada, e o token continua valendo.
  db(`update "User" set roles = array['USER','ADMIN']::"Role"[] where id = ${fx.sender.id}`);

  let token;

  try {
    token = await trpcAs(fx.sender.cookie, 'mutation', 'apiToken.create', {
      teamId: fx.teamId,
      tokenName: `aceite-f7-${RUN}`,
      expirationDate: null,
    });
  } finally {
    db(`update "User" set roles = array['USER']::"Role"[] where id = ${fx.sender.id}`);
  }

  assert.equal(token.status, 200, token.text);
  fx.senderToken = data(token).token;
});

after(async () => {
  if (SKIP || !adminCookie) {
    return;
  }

  if (fx.finance) {
    await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', { userId: fx.finance.id, member: false });
  }

  if (fx.accountant) {
    await trpcAs(adminCookie, 'mutation', 'revalle.accounting.adminSetMember', {
      userId: fx.accountant.id,
      isMember: false,
    });
  }

  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);

  if (fx.aiAvailable) {
    await fake('/__reset', {});
  }
});

testStep('1. o admin marca quem é do Financeiro e da Contabilidade', async () => {
  const finance = await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', {
    userId: fx.finance.id,
    member: true,
  });
  const accounting = await trpcAs(adminCookie, 'mutation', 'revalle.accounting.adminSetMember', {
    userId: fx.accountant.id,
    isMember: true,
  });

  assert.equal(finance.status, 200, finance.text);
  assert.equal(accounting.status, 200, accounting.text);
  assert.deepEqual(await pendingCounts(fx.sender.cookie), { finance: null, accounting: null });
  assert.equal(data(await trpcAs(fx.finance.cookie, 'query', 'revalle.finance.me')).isFinance, true);
  assert.equal(data(await trpcAs(fx.accountant.cookie, 'query', 'revalle.accounting.me')).isMember, true);
  assert.equal(data(await trpcAs(fx.accountant.cookie, 'query', 'revalle.finance.me')).isFinance, false);
});

testStep('2. o remetente recebe a sugestão, só envia com a conta e o centro, e os contadores sobem', async () => {
  fx.before = {
    finance: (await pendingCounts(fx.finance.cookie)).finance,
    accounting: (await pendingCounts(fx.accountant.cookie)).accounting,
  };

  const id = await newDraft('primeira');

  if (fx.aiAvailable) {
    await fake('/__program', { mode: 'ok', accountCode: ACCOUNT.code });

    const classified = await trpcAs(fx.sender.cookie, 'mutation', 'revalle.invoice.classify', { envelopeId: id });

    assert.equal(classified.status, 200, classified.text);

    let state;

    for (let i = 0; i < 60; i += 1) {
      state = data(await trpcAs(fx.sender.cookie, 'query', 'revalle.invoice.get', { envelopeId: id }));

      if (state.suggestionStatus !== 'PENDING') {
        break;
      }

      await sleep(400);
    }

    assert.equal(state.isInvoice, 'YES');
    assert.equal(state.suggestionStatus, 'DONE', JSON.stringify(state));
    assert.equal(state.suggestion.accountCode, ACCOUNT.code);
    // A sugestão nunca vira escolha sozinha.
    assert.equal(invoiceColumn(id, 'choiceCode'), '-');
  } else {
    const state = data(await trpcAs(fx.sender.cookie, 'query', 'revalle.invoice.get', { envelopeId: id }));

    assert.equal(state.isInvoice, 'YES');
    assert.equal(state.aiAvailable, false);
  }

  const onlyAccount = await chooseInvoice({
    cookie: fx.sender.cookie,
    envelopeId: id,
    code: ACCOUNT.code,
    costCenter: null,
  });

  assert.equal(onlyAccount.status, 200, onlyAccount.text);

  const refused = await api('POST', '/envelope/distribute', { envelopeId: id }, { apiToken: fx.senderToken });

  assert.equal(refused.status, 400, refused.text);
  assert.ok(refused.text.includes('INVOICE_ACCOUNT_REQUIRED'), refused.text);
  assert.equal(status(id), 'DRAFT');

  const chosen = await chooseInvoice({ cookie: fx.sender.cookie, envelopeId: id, code: null, costCenter: '101' });

  assert.equal(chosen.status, 200, chosen.text);

  const seen = await mailIdsTo(fx.signerEmail);

  assert.equal((await distribute(id, { apiToken: fx.senderToken })).length, 2);
  fx.first = loadVersion(id);
  assert.equal(financeStatus(id), 'PENDING_APPROVAL');
  assert.equal(invoiceColumn(id, 'costCenterCode'), '101');

  const [outsider] = fx.first.recipients.filter((recipient) => recipient.email === fx.signerEmail);

  await waitNewMail(fx.signerEmail, seen, {
    matches: (mail) => mail.Text?.includes(`/sign/${outsider.token}`),
    what: 'Convite',
  });

  assert.equal((await pendingCounts(fx.finance.cookie)).finance, fx.before.finance + 1);
  assert.equal((await pendingCounts(fx.accountant.cookie)).accounting, fx.before.accounting + 1);
  assert.ok(await isInQueue(fx.finance.cookie, id, { finance: 'pendentes' }), 'fora da fila do Financeiro');
  assert.ok(await isInQueue(fx.accountant.cookie, id, { accounting: 'pendentes' }), 'fora da fila da Contabilidade');
});

testStep('3. a Contabilidade valida: só a fila dela desce, e repetir não faz nada', async () => {
  const validated = await trpcAs(fx.accountant.cookie, 'mutation', 'revalle.accounting.validate', {
    envelopeId: fx.first.id,
  });

  assert.equal(validated.status, 200, validated.text);
  assert.equal(data(validated).validated, true);
  assert.equal(invoiceColumn(fx.first.id, 'costCenterValidatedByName'), fx.accountant.name);

  const again = await trpcAs(fx.accountant.cookie, 'mutation', 'revalle.accounting.validate', {
    envelopeId: fx.first.id,
  });

  assert.equal(data(again).validated, false);
  assert.equal((await pendingCounts(fx.accountant.cookie)).accounting, fx.before.accounting);
  assert.equal((await pendingCounts(fx.finance.cookie)).finance, fx.before.finance + 1);
  assert.equal(await isInQueue(fx.accountant.cookie, fx.first.id, { accounting: 'pendentes' }), false);
});

testStep('4. os signatários veem o centro e assinam; a nota fica retida', async () => {
  await sign(fx.first, fx.sender.email, PUXADA);
  await sign(fx.first, fx.signerEmail, PUXADA);
  await sleep(3000);

  assert.equal(status(fx.first.id), 'PENDING', 'a nota não ficou retida');
  assert.equal(financeStatus(fx.first.id), 'PENDING_APPROVAL');
  assert.equal(sealJobs(fx.first.documentId), 0, 'a conclusão disparou a selagem da nota retida');
});

// Passo próprio: sem a imagem do Playwright ele aparece como pulado, nunca como verde sem ter conferido.
testStep('4b. o View do remetente abre o documento (navegador)', async (t) => {
  if (!hasPlaywrightImage()) {
    t.skip(`imagem ${PLAYWRIGHT_IMAGE} ausente no Docker (docker pull ${PLAYWRIGHT_IMAGE})`);

    return;
  }

  const browser = await runBrowserScript({
    script: 'invoice-visibility.browser.mjs',
    payload: {
      phase: 'owner-view',
      baseUrl: BASE_URL,
      teamUrl: fx.teamUrl,
      cookies: { owner: fx.sender.cookie },
      own: { id: fx.first.id, title: fx.first.title },
    },
    timeout: 120_000,
  });

  t.diagnostic(browser.stdout);
  assert.equal(browser.status, 0, `${browser.stdout}\n${browser.stderr}`);
});

testStep(
  '5. o Financeiro aprova: COMPLETED, certificado com a conta e o centro, e a Contabilidade baixa o PDF',
  async () => {
    const approved = await trpcAs(fx.finance.cookie, 'mutation', 'revalle.finance.approve', {
      envelopeId: fx.first.id,
    });

    assert.equal(approved.status, 200, approved.text);
    assert.equal(await waitStatus(fx.first.id, 'COMPLETED'), 'COMPLETED');
    assert.equal(financeStatus(fx.first.id), 'APPROVED');
    assert.equal((await pendingCounts(fx.finance.cookie)).finance, fx.before.finance);

    const text = await sealedText(fx.first);

    assert.ok(
      text.includes(DOCUMENT_LINE(fx.finance.name, approvedAt(fx.first.id))),
      'certificado sem a conta aprovada',
    );
    assert.ok(text.includes(CENTER_LINE(PUXADA)), 'certificado sem a linha do centro');
    assert.equal(text.split(CENTER_SIGNER_ROW('101')).length - 1, 2, 'uma linha "visto ao assinar" por signatário');
    // A validação pode vir depois da selagem: o certificado não afirma nada sobre ela.
    assert.ok(!text.includes(fx.accountant.name), 'o certificado cita quem validou');

    const page = await fetchIdempotent(
      `${BASE_URL}/notas-fiscais/${fx.first.id}`,
      { headers: { Cookie: fx.accountant.cookie } },
      async (res) => ({ status: res.status, text: await res.text() }),
    );

    assert.equal(page.status, 200);
    assert.ok(page.text.includes('data-testid="invoice-view-download"'), 'a página da NF sem "Baixar PDF"');

    const pdf = await fetchIdempotent(
      `${BASE_URL}/notas-fiscais/${fx.first.id}/pdf/${fx.first.item}?download=1`,
      { headers: { Cookie: fx.accountant.cookie } },
      async (res) => ({
        status: res.status,
        type: res.headers.get('content-type'),
        disposition: res.headers.get('content-disposition'),
        body: Buffer.from(await res.arrayBuffer()),
      }),
    );

    assert.equal(pdf.status, 200);
    assert.equal(pdf.type, 'application/pdf');
    assert.match(pdf.disposition, /^attachment;.*_signed/);
    assert.equal(
      sha256(pdf.body),
      sha256(await downloadItem(fx.first.item, 'signed', { apiToken: fx.senderToken })),
      'a Contabilidade não baixou o PDF selado',
    );
  },
);

testStep(
  '6. segunda NF: a Contabilidade corrige de 101 para 201; link antigo bloqueado; aviso e convite para todos',
  async () => {
    const id = await newDraft('corrigida');
    const chosen = await chooseInvoice({ cookie: fx.sender.cookie, envelopeId: id, code: ACCOUNT.code });

    assert.equal(chosen.status, 200, chosen.text);
    await distribute(id, { apiToken: fx.senderToken });
    fx.second = loadVersion(id);

    await sign(fx.second, fx.sender.email, PUXADA);

    const people = [fx.sender.email, fx.signerEmail];
    const seen = await Promise.all(people.map(mailIdsTo));
    const corrected = await trpcAs(fx.accountant.cookie, 'mutation', 'revalle.accounting.changeCostCenter', {
      envelopeId: id,
      code: '201',
      reason: REASON,
    });

    assert.equal(corrected.status, 200, corrected.text);
    fx.secondV2 = loadVersion(data(corrected).newEnvelopeId);

    assert.equal(fx.secondV2.title, `${fx.second.title} (v2)`);
    assert.equal(financeStatus(id), 'SUPERSEDED');
    assert.equal(financeStatus(fx.secondV2.id), 'PENDING_APPROVAL');
    assert.equal(invoiceColumn(fx.secondV2.id, 'choiceCode'), ACCOUNT.code);
    assert.equal(invoiceColumn(fx.secondV2.id, 'costCenterCode'), '201');
    assert.equal(invoiceColumn(fx.secondV2.id, 'costCenterValidatedByName'), fx.accountant.name);

    const oldToken = fx.second.recipients.find((recipient) => recipient.email === fx.signerEmail);

    assert.ok((await signingPage(oldToken.token)).includes(GATE_MESSAGE), 'o link antigo não foi bloqueado');

    const refused = await trpc('envelope.field.sign', {
      token: oldToken.token,
      fieldId: oldToken.fieldId,
      fieldValue: { type: 'SIGNATURE', value: 'Teste Digitado' },
    });

    assert.ok(!refused.ok, 'assinou na versão substituída');
    assert.ok(refused.text.includes(GATE_MESSAGE), refused.text);

    for (const [index, email] of people.entries()) {
      const { token } = fx.secondV2.recipients.find((recipient) => recipient.email === email);
      const notice = await waitNewMail(email, seen[index], {
        matches: (mail) => mail.Subject === NOTICE_SUBJECT(fx.second.title),
        what: 'Aviso da correção',
      });

      assert.ok(flat(notice.Text).includes(NOTICE_LINE), flat(notice.Text));
      assert.ok(notice.Text.includes(`/sign/${token}`), 'o aviso sem o link da nova versão');

      await waitNewMail(email, seen[index], {
        matches: (mail) => mail.Subject !== notice.Subject && mail.Text?.includes(`/sign/${token}`),
        what: 'Convite da v2',
      });
    }
  },
);

testStep('7. todos assinam a v2, o Financeiro aprova e o certificado sai com 201', async () => {
  await sign(fx.secondV2, fx.sender.email, ARMAZEM);
  await sign(fx.secondV2, fx.signerEmail, ARMAZEM);
  await sleep(3000);
  assert.equal(status(fx.secondV2.id), 'PENDING', 'a v2 concluiu sem o Financeiro');

  const approved = await trpcAs(fx.finance.cookie, 'mutation', 'revalle.finance.approve', {
    envelopeId: fx.secondV2.id,
  });

  assert.equal(approved.status, 200, approved.text);
  assert.equal(await waitStatus(fx.secondV2.id, 'COMPLETED'), 'COMPLETED');

  const text = await sealedText(fx.secondV2);

  assert.ok(
    text.includes(DOCUMENT_LINE(fx.finance.name, approvedAt(fx.secondV2.id))),
    'certificado sem a conta aprovada',
  );
  assert.ok(text.includes(CENTER_LINE(ARMAZEM)), 'certificado sem o centro novo');
  assert.equal(text.split(CENTER_SIGNER_ROW('201')).length - 1, 2, 'uma linha "visto ao assinar" por signatário');
  assert.equal(text.split(CENTER_SIGNER_ROW('101')).length - 1, 0, 'a v2 traz o centro antigo como visto ao assinar');
  // A versão substituída nunca conclui.
  assert.equal(status(fx.second.id), 'PENDING');
  assert.equal(financeStatus(fx.second.id), 'SUPERSEDED');
});

testStep('8. nenhum e-mail ao Financeiro nem à Contabilidade em todo o fluxo', async () => {
  // Os jobs de e-mail do fim do fluxo rodam por trás.
  await sleep(3000);

  for (const person of [fx.finance, fx.accountant]) {
    const messages = await mailsTo(person.email);

    assert.equal(messages.length, 1, `${person.email}: ${messages.map((message) => message.Subject).join(' | ')}`);

    const { Text } = await mailById(messages[0].ID);

    assert.match(Text, /verify-email/, `${person.email} recebeu outro e-mail além da confirmação da conta`);
  }

  for (const doc of [fx.first, fx.second, fx.secondV2]) {
    assert.deepEqual(await workflowMails(doc), [], `${doc.title}: saiu e-mail de fluxo`);
    assert.equal(workflowJobs(doc.id), 0, `${doc.title}: job de e-mail de fluxo`);
  }

  // O endereço da contabilidade deixou de existir na configuração.
  const settings = data(await trpcAs(adminCookie, 'query', 'revalle.invoice.adminGetSettings'));

  assert.equal('accountingEmail' in settings, false);
});
