// Fase 9, Task 6: Financeiro e Contabilidade por nota num envio com várias notas fiscais.
//   - aprovar, trocar a conta, validar e corrigir o centro recebem a nota (`envelopeItemId`); sem ela, num envio de 2+
//     notas, 400 `INVOICE_FILE_REQUIRED`; com uma nota, sem ela, como sempre;
//   - o envio só conclui (e sela) quando a última nota é aprovada, uma vez só, mesmo com duas aprovações ao mesmo tempo;
//   - a nova versão (troca da conta ou correção do centro de UMA nota) deixa as três notas aguardando o Financeiro; as
//     contas, os centros e as validações das outras ficam; a versão antiga guarda a nota que mudou
//     (`supersededEnvelopeItemId`) e o aviso diz qual ("nota 2 de 3: nf-b.pdf");
//   - a Contabilidade valida nota a nota, e uma nota sem validar não segura a conclusão;
//   - envio antigo de uma nota (linha refeita pelo backfill da migração) aprova sem dizer a nota e sela como antes;
//   - a página da NF tem uma seção por nota e o cartão "Boletos do envio" com o aviso (quem só assina não vê o aviso).
//
// O contador da Contabilidade por nota (`pendingCounts`) é da Task 4: o caso que o confere falha até ela entrar.
//
// A IA não é usada na escolha (conta e centro à mão). Só o caso da página precisa do servidor FALSO do Gemini (o valor das
// notas, para o aviso do boleto); sem ele, é pulado. Nenhuma chamada ao Gemini de verdade.
//
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN, escolhe as contas) e REVSIGN_ADMIN_* (rsadmin, marcado como
// Financeiro aqui, importa a lista de contas). Contas novas de teste: uma do Financeiro e uma da Contabilidade (criadas no
// banco, ver account-helpers.mjs), desmarcadas no fim. Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import './account-autologin.mjs'; // conta obrigatória (16/11/2026): entra na conta de quem assina pelo e-mail da empresa
import { sessionFor } from './account-helpers.mjs';
import {
  api,
  appContainerEnv,
  assertNoPaidGeminiCalls,
  BASE_URL,
  boletoPdfFile,
  completeWithCode,
  db,
  downloadItem,
  fetchIdempotent,
  invoicePdfFile,
  mailIdsTo,
  markAutoAnnotation,
  poppler,
  retryCreateOnStaleSocket,
  runInvoiceFilesBackfill,
  signIn,
  trpc,
  trpcAs,
  waitNewMail,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const FAKE_URL = (process.env.REVSIGN_FAKE_GEMINI_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const REASON = 'Conta de serviço, não de material.';
const CENTER_REASON = 'O serviço foi do armazém, não da administração.';
const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
].join('\n');

// As três notas do envio: arquivo, conta e centro. A IA falsa lê R$ 1.500,00 de cada uma.
const NOTES = [
  { title: 'nf-a.pdf', code: '2.1.03', center: '101' },
  { title: 'nf-b.pdf', code: '2.1.03', center: '201' },
  { title: 'nf-c.pdf', code: '2.1.03', center: '301' },
];

// Textos exatos (plano da Fase 9, Task 6).
const FILE_REQUIRED = 'INVOICE_FILE_REQUIRED';
const STATE_CHANGED = 'A situação desta nota mudou. Atualize a página e tente de novo.';
const ACCOUNT_NOTICE = (title) =>
  `A conta contábil da nota fiscal ${title} (nota 2 de 3: nf-b.pdf) foi alterada pelo Financeiro de 2.1.03 – Fornecedores para 3.1.01 – Serviços de terceiros. Motivo: ${REASON}`;
const ACCOUNT_SUBJECT = (title) => `Conta contábil da nota fiscal alterada pelo Financeiro: ${title}`;
const NOTE_HEADING = 'Nota 2 de 3 · nf-b.pdf';
const BOLETO_WARNING = 'O valor do boleto (R$ 1.499,00) não bate com nenhuma nota do envio.';

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-financeiro-varias-notas-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flat = (text) => (text ?? '').replace(/\s+/g, ' ');

let userCookie;
let adminCookie;
let aiMode = 'off';
const fx = {};

const data = (res) => res.body?.result?.data?.json;
const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);
const classification = (envelopeId, column) =>
  db(
    `select coalesce("${column}"::text, '-') from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );
const financeStatus = (envelopeId) => classification(envelopeId, 'financeStatus');
// Colunas da linha de arquivo de uma nota (pelo item), em texto ('-' = nulo).
const fileColumn = (envelopeItemId, column) =>
  db(`select coalesce("${column}"::text, '-') from "RevalleInvoiceFile" where "envelopeItemId" = '${envelopeItemId}'`);
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

const waitStatus = async (envelopeId, wanted, attempts = 45) => {
  for (let i = 0; i < attempts && status(envelopeId) !== wanted; i += 1) {
    await sleep(2000);
  }

  return status(envelopeId);
};

const html = (route, cookie) =>
  fetchIdempotent(`${BASE_URL}${route}`, { headers: cookie ? { Cookie: cookie } : {} }, async (res) => ({
    status: res.status,
    text: await res.text(),
  }));

const approve = (cookie, envelopeId, envelopeItemId) =>
  trpcAs(cookie, 'mutation', 'revalle.finance.approve', { envelopeId, envelopeItemId });

const changeAccount = (cookie, envelopeId, envelopeItemId, code) =>
  trpcAs(cookie, 'mutation', 'revalle.finance.changeAccount', { envelopeId, envelopeItemId, code, reason: REASON });

// ---------- Envio ----------

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
    `select r.id || '|' || r.token || '|' || r.email || '|' || r."signingStatus" || '|' || coalesce((select string_agg(f.id::text, ',' order by f.id) from "Field" f where f."recipientId" = r.id and f.type = 'SIGNATURE'), '') from "Recipient" r where r."envelopeId" = '${envelopeId}' order by r.email`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, token, email, signingStatus, fieldIds] = line.split('|');

      return {
        id: Number(id),
        token,
        email,
        signingStatus,
        fieldIds: fieldIds.split(',').filter(Boolean).map(Number),
      };
    });

  return {
    id: envelopeId,
    title,
    documentId: Number.parseInt(secondaryId.split('_')[1], 10),
    items: loadItems(envelopeId),
    recipients,
  };
};

// Envio (API v2) com as notas dadas (e, se pedido, um boleto de `boletoCents`), um campo de assinatura de cada
// signatário em cada arquivo (o envio exige); conta e centro escolhidos à mão em cada nota; enviado.
const newInvoice = async (label, { notes = NOTES, signers = 2, boletoCents = null } = {}) => {
  const files = notes.map((note) =>
    invoicePdfFile({
      variant: note.title.replace('.pdf', ''),
      markers: { valor: '1500.00' },
      extraLines: [`${label} ${RUN}`],
    }),
  );

  if (boletoCents !== null) {
    const dueDate = new Date(Date.now() + 10 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Bahia' });

    files.push(boletoPdfFile({ variant: 'boleto', amountCents: boletoCents, dueDate }));
  }

  const title = `[TESTE NF] financeiro várias notas ${label} ${RUN}`;
  const emails = Array.from({ length: signers }, (_, index) => `f9-fin-${label}-${index + 1}-${RUN}@revalle.com.br`);
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
    data(classified).documents.map((doc) => doc.kind),
    [...notes.map(() => 'NF'), ...(boletoCents !== null ? ['BOLETO'] : [])],
  );

  const items = loadItems(envelopeId);

  for (const note of notes) {
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

  return envelopeId;
};

const send = async (envelopeId) => {
  const sent = await api('POST', '/envelope/distribute', { envelopeId });

  assert.equal(sent.status, 200, sent.text);
  assert.equal(financeStatus(envelopeId), 'PENDING_APPROVAL');

  return loadVersion(envelopeId);
};

const newSentInvoice = async (label, options) => await send(await newInvoice(label, options));

// ---------- Assinatura ----------

const gate = async (token) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

// Portão, a assinatura em cada arquivo e a conclusão com o código.
const sign = async (doc, index) => {
  const recipient = doc.recipients[index];

  await gate(recipient.token);

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

const signAll = async (doc) => {
  for (let index = 0; index < doc.recipients.length; index += 1) {
    await sign(doc, index);
  }
};

// Texto do PDF selado de um arquivo (documento, certificado e log), com os espaços normalizados.
const sealedText = async (itemId) => {
  const dir = mkdtempSync(path.join(tmp, 'selado-'));

  writeFileSync(path.join(dir, 'signed.pdf'), await downloadItem(itemId, 'signed'));

  return flat(poppler(dir, 'pdftotext /pdf/signed.pdf -'));
};

const count = (text, piece) => text.split(piece).length - 1;

// A IA ainda lendo alguma nota ou o boleto.
const isReading = (state) =>
  state.suggestionStatus === 'PENDING' ||
  state.documents.some((doc) => doc.suggestionStatus === 'PENDING' || doc.boleto?.status === 'PENDING');

const approvedEvents = (envelopeId) =>
  db(
    `select coalesce(data->'document'->>'envelopeItemId', '-') from "DocumentAuditLog" where "envelopeId" = '${envelopeId}' and type = 'REVALLE_FINANCE_APPROVED' order by "createdAt"`,
  )
    .split('\n')
    .filter(Boolean);

// ---------- Casos ----------

const sessionTest = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie || !adminCookie) {
      t.skip('credenciais de sessão não informadas');

      return;
    }

    await fn(t);
  });

const aiTest = (name, fn) =>
  sessionTest(name, async (t) => {
    if (aiMode !== 'fake') {
      t.skip('stack sem o servidor falso do Gemini (suba com compose.test.yml)');

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

  // A segunda pessoa do Financeiro e a da Contabilidade: contas de teste novas.
  for (const [key, label] of [
    ['finance', 'financeiro'],
    ['accountant', 'contabilidade'],
  ]) {
    const email = `f9-fin-${label}-${RUN}@revalle.com.br`;
    const cookie = await sessionFor(email);

    fx[key] = { email, cookie, id: Number(db(`select id from "User" where email = '${email}'`)) };
  }

  const financeMember = await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', {
    userId: fx.finance.id,
    member: true,
  });

  assert.equal(financeMember.status, 200, financeMember.text);

  const accountingMember = await trpcAs(adminCookie, 'mutation', 'revalle.accounting.adminSetMember', {
    userId: fx.accountant.id,
    isMember: true,
  });

  assert.equal(accountingMember.status, 200, accountingMember.text);

  const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });

  assert.equal(imported.status, 200, imported.text);
  db(`delete from "RateLimit" where action like 'revalle.invoice%'`);

  const hasKey = appContainerEnv('GEMINI_API_KEY').trim() !== '';
  const disabled = appContainerEnv('NEXT_PRIVATE_REVALLE_INVOICE_AI').trim().toLowerCase() === 'disabled';
  const fakeUp = await fetch(`${FAKE_URL}/__health`)
    .then((res) => res.ok)
    .catch(() => false);

  aiMode = hasKey && !disabled && fakeUp ? 'fake' : 'off';
});

after(async () => {
  if (!adminCookie) {
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
});

beforeEach(() => {
  db('delete from "RateLimit"');
});

sessionTest('aprovar sem dizer a nota num envio de três: INVOICE_FILE_REQUIRED', async () => {
  // Com um boleto: o arquivo que não é nota também não serve para aprovar.
  const doc = await newSentInvoice('sem-nota', { boletoCents: 149900 });

  for (const res of [
    await approve(adminCookie, doc.id),
    await changeAccount(adminCookie, doc.id, undefined, '3.1.01'),
    await trpcAs(fx.accountant.cookie, 'mutation', 'revalle.accounting.validate', { envelopeId: doc.id }),
    await trpcAs(adminCookie, 'query', 'revalle.finance.get', { envelopeId: doc.id }),
  ]) {
    assert.equal(res.status, 400, res.text);
    assert.ok(res.text.includes(FILE_REQUIRED), res.text);
  }

  // Nada foi gravado: o envio continua aguardando, sem nova versão.
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
  assert.deepEqual(approvedEvents(doc.id), []);

  // Item de outro envio: 404.
  // Um arquivo de verdade, mas de outro envio: 404. O boleto do próprio envio (não é nota): 404 também.
  const foreignItem = db(
    `select i.id from "EnvelopeItem" i join "Envelope" e on e.id = i."envelopeId" where i."envelopeId" <> '${doc.id}' order by e."createdAt" desc limit 1`,
  );

  assert.ok(foreignItem, 'nenhum arquivo de outro envio no banco');

  for (const envelopeItemId of [foreignItem, doc.items['boleto.pdf']]) {
    assert.ok(envelopeItemId);

    const res = await approve(adminCookie, doc.id, envelopeItemId);

    assert.equal(res.status, 404, res.text);
    assert.ok(res.text.includes('Nota fiscal não encontrada neste envio.'), res.text);
  }

  assert.deepEqual(approvedEvents(doc.id), []);
});

sessionTest('aprova 2 de 3: não conclui; aprova a 3ª: conclui e sela', async () => {
  const doc = await newSentInvoice('aprova');

  await signAll(doc);
  assert.equal(status(doc.id), 'PENDING');

  for (const title of ['nf-a.pdf', 'nf-b.pdf']) {
    const res = await approve(adminCookie, doc.id, doc.items[title]);

    assert.equal(res.status, 200, res.text);
    assert.deepEqual(data(res), { approved: true });
  }

  // Duas de três: o envio continua aguardando, retido, sem selagem.
  await sleep(2000);
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
  assert.equal(status(doc.id), 'PENDING');
  assert.equal(sealJobs(doc.documentId), 0, 'selagem disparada antes da última nota');
  assert.equal(classification(doc.id, 'approvedAt'), '-', 'o espelho aprovado com uma nota faltando');

  // O cartão da nota já aprovada diz aprovada; o da que falta, aguardando.
  const cardA = data(
    await trpcAs(adminCookie, 'query', 'revalle.finance.get', {
      envelopeId: doc.id,
      envelopeItemId: doc.items['nf-a.pdf'],
    }),
  );
  const cardC = data(
    await trpcAs(adminCookie, 'query', 'revalle.finance.get', {
      envelopeId: doc.id,
      envelopeItemId: doc.items['nf-c.pdf'],
    }),
  );

  assert.equal(cardA.financeStatus, 'APPROVED');
  assert.equal(cardC.financeStatus, 'PENDING_APPROVAL');
  assert.deepEqual(cardC.position, { index: 3, total: 3 });

  const last = await approve(adminCookie, doc.id, doc.items['nf-c.pdf']);

  assert.equal(last.status, 200, last.text);
  assert.deepEqual(data(last), { approved: true });
  assert.equal(financeStatus(doc.id), 'APPROVED');
  assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');

  for (const note of NOTES) {
    assert.notEqual(fileColumn(doc.items[note.title], 'approvedAt'), '-', `${note.title} sem aprovação`);
  }

  // Um evento por nota, com a nota.
  assert.deepEqual([...approvedEvents(doc.id)].sort(), NOTES.map((note) => doc.items[note.title]).sort());

  // O espelho: a última aprovação (é o que a varredura de selagem lê).
  assert.equal(
    db(
      `select (select "approvedAt" from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}') = (select max("approvedAt") from "RevalleInvoiceFile" where "envelopeId" = '${doc.id}' and kind = 'NF')`,
    ),
    't',
  );
});

sessionTest('aprovar de novo a mesma nota não faz nada', async () => {
  const doc = await newSentInvoice('repete');
  const item = doc.items['nf-a.pdf'];
  const first = await approve(adminCookie, doc.id, item);

  assert.equal(first.status, 200, first.text);
  assert.deepEqual(data(first), { approved: true });

  const approvedAt = fileColumn(item, 'approvedAt');
  const again = await approve(fx.finance.cookie, doc.id, item);

  assert.equal(again.status, 200, again.text);
  assert.deepEqual(data(again), { approved: false });
  assert.equal(fileColumn(item, 'approvedAt'), approvedAt, 'a segunda aprovação gravou de novo');
  assert.equal(fileColumn(item, 'approvedById'), db(`select id from "User" where email = '${admin.email}'`));
  assert.deepEqual(approvedEvents(doc.id), [item]);
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
});

sessionTest('troca a conta da 2ª: nova versão, todos assinam de novo, as três reabrem', async () => {
  const v1 = await newSentInvoice('troca');

  await signAll(v1);

  for (const title of ['nf-a.pdf', 'nf-c.pdf']) {
    const res = await approve(adminCookie, v1.id, v1.items[title]);

    assert.equal(res.status, 200, res.text);
  }

  // A Contabilidade valida a nota a: a validação vai junto para a nova versão.
  const validated = await trpcAs(fx.accountant.cookie, 'mutation', 'revalle.accounting.validate', {
    envelopeId: v1.id,
    envelopeItemId: v1.items['nf-a.pdf'],
  });

  assert.equal(validated.status, 200, validated.text);
  assert.deepEqual(data(validated), { validated: true });

  const seen = await mailIdsTo(v1.recipients[0].email);
  const changed = await changeAccount(adminCookie, v1.id, v1.items['nf-b.pdf'], '3.1.01');

  assert.equal(changed.status, 200, changed.text);

  const v2 = loadVersion(data(changed).newEnvelopeId);

  // A versão antiga: substituída, com a nota que mudou.
  assert.equal(financeStatus(v1.id), 'SUPERSEDED');
  assert.equal(classification(v1.id, 'supersededEnvelopeItemId'), v1.items['nf-b.pdf']);
  assert.equal(classification(v1.id, 'supersededByEnvelopeId'), v2.id);

  // A nova: três notas, a e c com a conta de antes, b com a nova; todas sem aprovação; centros e validações iguais.
  assert.equal(await waitStatus(v2.id, 'PENDING', 15), 'PENDING');
  assert.equal(financeStatus(v2.id), 'PENDING_APPROVAL');
  assert.equal(
    Number(db(`select count(*) from "RevalleInvoiceFile" where "envelopeId" = '${v2.id}' and kind = 'NF'`)),
    3,
  );

  for (const note of NOTES) {
    const [oldItem, newItem] = [v1.items[note.title], v2.items[note.title]];

    assert.ok(newItem, `${note.title} não está na nova versão`);
    assert.equal(fileColumn(newItem, 'choiceCode'), note.title === 'nf-b.pdf' ? '3.1.01' : '2.1.03');
    assert.equal(fileColumn(newItem, 'approvedAt'), '-', `${note.title} aprovada na nova versão`);
    assert.equal(fileColumn(newItem, 'costCenterCode'), note.center);
    assert.equal(fileColumn(newItem, 'costCenterValidatedAt'), fileColumn(oldItem, 'costCenterValidatedAt'));
  }

  assert.equal(
    fileColumn(v2.items['nf-b.pdf'], 'choiceById'),
    db(`select id from "User" where email = '${admin.email}'`),
  );
  assert.notEqual(fileColumn(v2.items['nf-a.pdf'], 'costCenterValidatedAt'), '-');

  // Todos assinam de novo.
  for (const recipient of v2.recipients) {
    assert.equal(recipient.signingStatus, 'NOT_SIGNED');
  }

  // O aviso diz qual nota mudou.
  const notice = await waitNewMail(v1.recipients[0].email, seen, {
    matches: (mail) => mail.Subject === ACCOUNT_SUBJECT(v1.title),
    what: 'aviso da troca de conta',
  });

  assert.ok(flat(notice.Text).includes(ACCOUNT_NOTICE(v1.title)), flat(notice.Text));

  // O evento da troca nas duas versões, com a nota.
  for (const [envelopeId, item] of [
    [v1.id, v1.items['nf-b.pdf']],
    [v2.id, v2.items['nf-b.pdf']],
  ]) {
    assert.equal(
      db(
        `select data->'document'->>'envelopeItemId' || '|' || (data->'document'->>'index') || '|' || (data->'document'->>'total') from "DocumentAuditLog" where "envelopeId" = '${envelopeId}' and type = 'REVALLE_FINANCE_ACCOUNT_CHANGED'`,
      ),
      `${item}|2|3`,
    );
  }

  fx.v2 = v2;
});

sessionTest('Contabilidade corrige o centro de uma nota: nova versão', async (t) => {
  if (!fx.v2) {
    t.skip('depende da troca de conta acima');

    return;
  }

  const v2 = fx.v2;
  const corrected = await trpcAs(fx.accountant.cookie, 'mutation', 'revalle.accounting.changeCostCenter', {
    envelopeId: v2.id,
    envelopeItemId: v2.items['nf-c.pdf'],
    code: '201',
    reason: CENTER_REASON,
  });

  assert.equal(corrected.status, 200, corrected.text);

  const v3 = loadVersion(data(corrected).newEnvelopeId);

  assert.equal(financeStatus(v2.id), 'SUPERSEDED');
  assert.equal(classification(v2.id, 'supersededEnvelopeItemId'), v2.items['nf-c.pdf']);
  assert.equal(await waitStatus(v3.id, 'PENDING', 15), 'PENDING');
  assert.equal(financeStatus(v3.id), 'PENDING_APPROVAL');

  const c = v3.items['nf-c.pdf'];

  assert.equal(fileColumn(c, 'costCenterCode'), '201');
  assert.equal(fileColumn(c, 'costCenterValidatedById'), String(fx.accountant.id));

  for (const title of ['nf-a.pdf', 'nf-b.pdf']) {
    assert.equal(fileColumn(v3.items[title], 'costCenterCode'), fileColumn(v2.items[title], 'costCenterCode'));
    assert.equal(
      fileColumn(v3.items[title], 'costCenterValidatedAt'),
      fileColumn(v2.items[title], 'costCenterValidatedAt'),
    );
    assert.equal(fileColumn(v3.items[title], 'choiceCode'), fileColumn(v2.items[title], 'choiceCode'));
  }

  for (const title of ['nf-a.pdf', 'nf-b.pdf', 'nf-c.pdf']) {
    assert.equal(fileColumn(v3.items[title], 'approvedAt'), '-', `${title} aprovada na v3`);
  }

  assert.equal(
    db(
      `select data->'document'->>'envelopeItemId' from "DocumentAuditLog" where "envelopeId" = '${v3.id}' and type = 'REVALLE_COST_CENTER_CHANGED'`,
    ),
    c,
  );
});

sessionTest('Contabilidade valida uma nota por vez e não segura a conclusão', async () => {
  const doc = await newSentInvoice('valida');
  const start = (await pendingCounts(fx.accountant.cookie)).accounting;

  for (const [i, title] of ['nf-a.pdf', 'nf-b.pdf'].entries()) {
    const res = await trpcAs(fx.accountant.cookie, 'mutation', 'revalle.accounting.validate', {
      envelopeId: doc.id,
      envelopeItemId: doc.items[title],
    });

    assert.equal(res.status, 200, res.text);
    assert.deepEqual(data(res), { validated: true });
    assert.equal(fileColumn(doc.items[title], 'costCenterValidatedById'), String(fx.accountant.id));
    // Task 4: o contador conta notas.
    assert.equal((await pendingCounts(fx.accountant.cookie)).accounting, start - (i + 1));
  }

  assert.equal(fileColumn(doc.items['nf-c.pdf'], 'costCenterValidatedAt'), '-');
  assert.equal(
    db(
      `select string_agg(data->'document'->>'envelopeItemId', ',' order by "createdAt") from "DocumentAuditLog" where "envelopeId" = '${doc.id}' and type = 'REVALLE_COST_CENTER_VALIDATED'`,
    ),
    `${doc.items['nf-a.pdf']},${doc.items['nf-b.pdf']}`,
  );

  // A nota c sem validação não segura a conclusão.
  await signAll(doc);

  for (const note of NOTES) {
    assert.equal((await approve(adminCookie, doc.id, doc.items[note.title])).status, 200);
  }

  assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');
});

sessionTest('duas aprovações das últimas notas ao mesmo tempo selam uma vez', async () => {
  for (let round = 1; round <= 3; round += 1) {
    const doc = await newSentInvoice(`par-${round}`, { signers: 1 });

    await signAll(doc);
    assert.equal((await approve(adminCookie, doc.id, doc.items['nf-a.pdf'])).status, 200);
    assert.equal(sealJobs(doc.documentId), 0, `rodada ${round}: selagem antes do par`);

    const [b, c] = await Promise.all([
      approve(adminCookie, doc.id, doc.items['nf-b.pdf']),
      approve(fx.finance.cookie, doc.id, doc.items['nf-c.pdf']),
    ]);

    assert.equal(b.status, 200, b.text);
    assert.equal(c.status, 200, c.text);
    assert.deepEqual([data(b), data(c)], [{ approved: true }, { approved: true }]);
    assert.equal(financeStatus(doc.id), 'APPROVED');
    assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');
    assert.equal(sealJobs(doc.documentId), 1, `rodada ${round}: selagem disparada mais de uma vez`);
    assert.equal(approvedEvents(doc.id).length, 3);
  }
});

sessionTest('aprovação e troca de conta ao mesmo tempo', async () => {
  const doc = await newSentInvoice('corrida');
  const [approved, changed] = await Promise.all([
    approve(adminCookie, doc.id, doc.items['nf-a.pdf']),
    changeAccount(fx.finance.cookie, doc.id, doc.items['nf-b.pdf'], '3.1.01'),
  ]);
  const a = doc.items['nf-a.pdf'];

  if (changed.status !== 200) {
    // A aprovação venceu: a troca recomeça, nada substituído.
    assert.equal(changed.status, 400, changed.text);
    assert.ok(changed.text.includes(STATE_CHANGED), changed.text);
    assert.equal(approved.status, 200, approved.text);
    assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
    assert.notEqual(fileColumn(a, 'approvedAt'), '-');

    return;
  }

  const v2 = loadVersion(data(changed).newEnvelopeId);

  assert.equal(financeStatus(doc.id), 'SUPERSEDED');

  for (const title of ['nf-a.pdf', 'nf-b.pdf', 'nf-c.pdf']) {
    assert.equal(fileColumn(v2.items[title], 'approvedAt'), '-', `${title} aprovada na nova versão`);
  }

  if (approved.status === 200) {
    // A aprovação veio antes da marca: ficou na versão antiga, e a nova reabre. Prova da ordem: o evento da aprovação é
    // de uma transação que começou antes da que registrou a troca na versão antiga (as duas datas são do banco; a
    // `supersededAt` não serve: é lida no começo do pedido da troca, antes de ele conferir as notas, e uma aprovação
    // gravada nesse meio é legítima).
    assert.notEqual(fileColumn(a, 'approvedAt'), '-');
    assert.equal(
      db(
        `select (select max("createdAt") from "DocumentAuditLog" where "envelopeId" = '${doc.id}' and type = 'REVALLE_FINANCE_APPROVED') < (select min("createdAt") from "DocumentAuditLog" where "envelopeId" = '${doc.id}' and type = 'REVALLE_FINANCE_ACCOUNT_CHANGED')`,
      ),
      't',
      'aprovação gravada na versão antiga depois da troca',
    );
  } else {
    // A marca veio antes: a aprovação não grava nada na versão antiga.
    assert.equal(approved.status, 400, approved.text);
    assert.ok(approved.text.includes(STATE_CHANGED), approved.text);
    assert.equal(fileColumn(a, 'approvedAt'), '-', 'aprovação gravada na versão antiga depois da marca');
    assert.deepEqual(approvedEvents(doc.id), []);
  }
});

sessionTest('envio antigo de uma nota, aprovado depois da atualização', async () => {
  const doc = await newSentInvoice('antigo', { notes: [{ title: 'nf-unica.pdf', code: '2.1.03', center: '101' }] });

  await signAll(doc);
  assert.equal(status(doc.id), 'PENDING');

  // Como um envio de antes da Fase 9: sem linha de arquivo; a migração a cria de novo. E de antes do bloco de conta e
  // centro: o texto sai sozinho acima da assinatura (`autoAnnotation`, marcado pela migração do bloco).
  db(`delete from "RevalleInvoiceFile" where "envelopeId" = '${doc.id}'`);
  runInvoiceFilesBackfill();
  markAutoAnnotation(doc.id);
  assert.equal(
    db(`select count(*) || '|' || min(kind::text) from "RevalleInvoiceFile" where "envelopeId" = '${doc.id}'`),
    '1|NF',
  );

  const res = await approve(adminCookie, doc.id);

  assert.equal(res.status, 200, res.text);
  assert.deepEqual(data(res), { approved: true });
  assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');

  // O evento como antes, sem a nota.
  assert.deepEqual(approvedEvents(doc.id), ['-']);

  const text = await sealedText(doc.items['nf-unica.pdf']);

  assert.equal(count(text, 'Conta: 2.1.03 - Fornecedores'), 1, text);
  assert.ok(text.includes('Conta contábil: 2.1.03 – Fornecedores · aprovada pelo Financeiro ('), text);
  assert.ok(!text.includes('Nota 1 de 1'), 'o certificado de uma nota ganhou o rótulo de várias');
});

aiTest('página da NF: uma seção por nota e o aviso do boleto', async () => {
  const envelopeId = await newInvoice('pagina', { boletoCents: 149900 });

  // A leitura da IA (falsa) das notas e do boleto, até o fim.
  const deadline = performance.now() + 40_000;
  let state;

  do {
    await sleep(500);
    state = data(await trpcAs(userCookie, 'query', 'revalle.invoice.get', { envelopeId }));
  } while (isReading(state) && performance.now() < deadline);

  assert.ok(!isReading(state), 'a leitura da IA não terminou');

  const doc = await send(envelopeId);
  const financePage = await html(`/notas-fiscais/${doc.id}`, adminCookie);

  assert.equal(financePage.status, 200);
  assert.ok(financePage.text.includes(NOTE_HEADING), `sem "${NOTE_HEADING}"`);
  assert.ok(financePage.text.includes(`id="nota-${doc.items['nf-b.pdf']}"`), 'sem a âncora da nota');
  assert.ok(financePage.text.includes(BOLETO_WARNING), `sem "${BOLETO_WARNING}"`);

  const ownerPage = await html(`/notas-fiscais/${doc.id}`, userCookie);

  assert.equal(ownerPage.status, 200);
  assert.ok(ownerPage.text.includes(BOLETO_WARNING), 'o dono não vê o aviso do boleto');

  const signerPage = await html(`/notas-fiscais/${doc.id}`, await sessionFor(doc.recipients[0].email));

  assert.equal(signerPage.status, 200);
  assert.ok(signerPage.text.includes(NOTE_HEADING), 'quem assina não vê as notas');
  assert.ok(!signerPage.text.includes(BOLETO_WARNING), 'quem só assina vê o aviso do boleto');

  const card = await trpcAs(adminCookie, 'query', 'revalle.finance.get', {
    envelopeId: doc.id,
    envelopeItemId: doc.items['nf-b.pdf'],
  });

  assert.equal(card.status, 200, card.text);
  assert.deepEqual(data(card).position, { index: 2, total: 3 });
  assert.equal(data(card).documentTitle, 'nf-b.pdf');
  assert.equal(data(card).envelopeItemId, doc.items['nf-b.pdf']);
});
