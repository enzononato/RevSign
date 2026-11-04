// Fase 7, Task 7: tudo dentro do sistema, sem e-mail de fluxo. Confere:
//   - `revalle.invoice.pendingCounts`: 401 sem sessão; `{ finance: null, accounting: null }` para quem não tem perfil
//     (e `null` só no perfil que a pessoa não tem); a conta da Contabilidade sobe ao enviar uma NF e desce ao validar
//     (sem mexer na do Financeiro); a do Financeiro sobe ao enviar e desce ao aprovar (sem mexer na da Contabilidade); NF
//     recusada, substituída e excluída saem das duas; NF concluída e ainda sem validação continua na da Contabilidade;
//   - o número do menu é o mesmo da fila da página (`financeiro=pendentes` e `contabilidade=pendentes` em `find`), e o
//     aviso do admin (`accountingPendingCount`) é o mesmo da Contabilidade;
//   - lista (`find`): centro de custo, validação e quem validou em cada linha; filtro `contabilidade` (pendentes,
//     validadas, todas) respeitando a visibilidade; a página abre com as colunas novas;
//   - planilha (`/notas-fiscais/csv`): as quatro colunas novas vêm depois de `aprovado_por`, o filtro `contabilidade` vale,
//     `validado_por` é o nome congelado (mudar o nome da pessoa depois não muda a planilha) e fica vazio sem validação;
//   - `GET /notas-fiscais/:id/pdf/:itemId?download=1` responde como anexo (e `_signed` quando concluída); sem `download`
//     continua a prévia; sem acesso, 404;
//   - página de conclusão de quem assinou, com o documento pendente (também esperando o Financeiro): traz o link "Ver
//     documento" para o PDF de cada arquivo, o link abre o PDF (200, `application/pdf`) e some quando o documento conclui;
//     numa versão substituída o PDF não abre e a página não traz o link.
//
// O contador do menu, a fila com que a página abre e o botão "View" das listas são desenhados no navegador (as consultas
// rodam lá, o HTML do servidor só traz a moldura): o teste do navegador, no fim deste arquivo, abre as telas de verdade
// na imagem do Playwright (pula, dizendo por quê, se a imagem não estiver no Docker).
//
// Sessões: REVSIGN_USER_* (admin@hml.local, dono do REVSIGN_API_TOKEN, fora dos perfis), REVSIGN_ADMIN_* (rsadmin, ADMIN,
// marcado como Financeiro e nunca como Contabilidade) e contas novas a cada execução: a Contabilidade, o Financeiro, uma
// pessoa com os dois perfis e uma sem perfil. Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

import {
  assertNoPaidGeminiCalls,
  BASE_URL,
  chooseInvoice,
  computeEmailCode,
  createEnvelope,
  db,
  distribute,
  fetchIdempotent,
  hasPlaywrightImage,
  PLAYWRIGHT_IMAGE,
  retryCreateOnStaleSocket,
  runBrowserScript,
  signIn,
  signupColaborador,
  trpc,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = `Visi-${RUN}-Senha!9`;
const MAILPIT = 'http://localhost:8025/api/v1';
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const origin = new URL(BASE_URL).origin;

const GATE_MESSAGE = 'Este documento foi substituído por uma nova versão.';
const SIGNING_FILE = (token, itemId) => `/api/files/token/${token}/envelopeItem/${itemId}`;

const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
].join('\n');

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-visibilidade-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userCookie;
let adminCookie;
let accountant;
let financeOnly;
let both;
let outsider;

const data = (res) => res.body?.result?.data?.json;

const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);
const invoiceRow = (envelopeId, columns) =>
  db(`select ${columns} from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`);

const waitStatus = async (envelopeId, wanted, attempts = 45) => {
  for (let i = 0; i < attempts && status(envelopeId) !== wanted; i += 1) {
    await sleep(2000);
  }

  return status(envelopeId);
};

const mailsTo = async (to) =>
  (await fetchIdempotent(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`, {}, (res) => res.json()))
    .messages ?? [];
const mailBody = (id) => fetchIdempotent(`${MAILPIT}/message/${id}`, {}, (res) => res.json());

const waitFirstMail = async (to, timeoutMs = 40_000) => {
  const deadline = performance.now() + timeoutMs;

  do {
    const [first] = await mailsTo(to);

    if (first) {
      return first;
    }

    await sleep(500);
  } while (performance.now() < deadline);

  return undefined;
};

const newAccount = async (label) => {
  const email = `f7-vis-${label}-${RUN}@revalle.com.br`;
  const created = await signupColaborador({ name: `Visibilidade Teste ${label}`, email, password: PASSWORD });

  assert.ok(created.ok, `cadastro de ${label} falhou (${created.status}): ${await created.text()}`);

  const message = await waitFirstMail(email);

  assert.ok(message, `e-mail de confirmação de ${label} não chegou`);

  const html = (await mailBody(message.ID)).HTML ?? '';
  const token = html.match(/\/verify-email\/([A-Za-z0-9_-]+)/)?.[1];

  assert.ok(token, `link de confirmação ausente para ${label}`);

  const verified = await fetch(`${BASE_URL}/api/auth/email-password/verify-email`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  assert.equal(verified.status, 200, await verified.text());

  return {
    email,
    name: `Visibilidade Teste ${label}`,
    id: Number(db(`select id from "User" where email = '${email}'`)),
    cookie: await signIn(email, PASSWORD),
  };
};

// DANFE fictício; `variant` muda o arquivo (outra SHA-256, sem cache da sugestão).
const danfe = async (variant) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  let y = 800;

  for (const line of [
    'DANFE - Documento Auxiliar da Nota Fiscal Eletrônica',
    'Nº 000.012.345   Série 001',
    'Chave de Acesso',
    '2924 1012 3456 7800 0195 5500 1000 0123 4511 2345 6784',
    'Natureza da Operação: Venda de mercadoria adquirida de terceiros',
    'Emitente: Distribuidora Fictícia de Ferragens Ltda   CNPJ 12.345.678/0001-95',
    `Referência do teste: visibilidade ${variant} ${RUN}`,
    'Valor Total da Nota: R$ 150,00',
  ]) {
    page.drawText(line, { x: 40, y, size: 10, font, color: rgb(0, 0, 0) });
    y -= 16;
  }

  const file = path.join(tmp, `danfe-${variant}.pdf`);

  writeFileSync(file, Buffer.from(await doc.save()));

  return file;
};

// Lê uma versão do banco: destinatários (com token) e campos, como a tela de assinatura usa.
const loadVersion = (envelopeId) => {
  const [secondaryId, title] = db(`select "secondaryId" || '|' || title from "Envelope" where id = '${envelopeId}'`)
    .split(/\|(.*)/s)
    .slice(0, 2);
  const recipients = db(
    `select id || '|' || token || '|' || email from "Recipient" where "envelopeId" = '${envelopeId}' order by email`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, token, email] = line.split('|');

      return { id: Number(id), token, email };
    });
  const fields = db(
    `select id || '|' || "recipientId" || '|' || type from "Field" where "envelopeId" = '${envelopeId}' order by id`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, recipientId, type] = line.split('|');

      return { id: Number(id), recipientId: Number(recipientId), type };
    });
  const itemId = db(`select id from "EnvelopeItem" where "envelopeId" = '${envelopeId}' order by "order" limit 1`);

  return {
    id: envelopeId,
    title,
    itemId,
    documentId: Number.parseInt(secondaryId.split('_')[1], 10),
    recipients,
    fields,
  };
};

// NF do usuário comum com a conta 2.1.03 e o centro (101 por padrão). `send: false` deixa o rascunho.
const newInvoice = async (label, { signers = 1, send = true, center = '101', recipientEmails } = {}) => {
  const emails =
    recipientEmails ??
    Array.from({ length: signers }, (_, index) => `f7-vis-${label}-${index + 1}-${RUN}@revalle.com.br`);
  const title = `[TESTE NF] visibilidade ${label} ${RUN}`;
  const pdf = await danfe(label);
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({ recipients: emails.map((email) => ({ email })), pdf, title }),
  );

  assert.equal(created.status, 200, created.text);

  const chosen = await chooseInvoice({ cookie: userCookie, envelopeId: created.id, costCenter: center });

  assert.equal(chosen.status, 200, chosen.text);

  if (send) {
    assert.equal((await distribute(created.id)).length, emails.length);
    assert.equal(invoiceRow(created.id, '"financeStatus"'), 'PENDING_APPROVAL');
  }

  return loadVersion(created.id);
};

const gate = async (token) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

// Portão, página aberta, assinatura e conclusão do destinatário `index`. O código é calculado no container do app.
const sign = async (doc, index) => {
  const recipient = doc.recipients[index];

  await gate(recipient.token);
  await fetchIdempotent(`${BASE_URL}/sign/${recipient.token}`, {}, (res) => res.text());

  const field = doc.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');
  const signed = await trpc('envelope.field.sign', {
    token: recipient.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Teste Digitado' },
  });

  assert.equal(signed.status, 200, signed.text);

  const completion = await trpc('recipient.completeDocumentWithToken', {
    token: recipient.token,
    documentId: doc.documentId,
    accessAuthOptions: {
      type: 'TWO_FACTOR_AUTH',
      method: 'email',
      token: computeEmailCode({ email: recipient.email, envelopeId: doc.id }),
    },
  });

  assert.ok(completion.ok, completion.text);
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
};

const pendingCounts = async (cookie) => {
  const res = await trpcAs(cookie, 'query', 'revalle.invoice.pendingCounts');

  assert.equal(res.status, 200, res.text);

  return data(res);
};

const find = async (cookie, filters = {}) => {
  const res = await trpcAs(cookie, 'query', 'revalle.invoice.find', { perPage: 100, ...filters });

  assert.equal(res.status, 200, res.text);

  return data(res);
};

const validate = (envelopeId, cookie = accountant.cookie) =>
  trpcAs(cookie, 'mutation', 'revalle.accounting.validate', { envelopeId });
const approve = (envelopeId, cookie = financeOnly.cookie) =>
  trpcAs(cookie, 'mutation', 'revalle.finance.approve', { envelopeId });
const changeAccount = (envelopeId) =>
  trpcAs(adminCookie, 'mutation', 'revalle.finance.changeAccount', {
    envelopeId,
    code: '3.1.01',
    reason: 'Conta de serviço, não de material.',
  });

// O texto sai do corpo em bytes: `res.text()` descarta o BOM, e a planilha precisa dele (o Excel abre em UTF-8).
const csv = async (cookie, query = '') =>
  fetchIdempotent(`${BASE_URL}/notas-fiscais/csv${query}`, { headers: { Cookie: cookie } }, async (res) => ({
    status: res.status,
    text: Buffer.from(await res.arrayBuffer()).toString('utf8'),
  }));

const csvRows = (text) =>
  text
    .replace('﻿', '')
    .split('\r\n')
    .filter(Boolean)
    .map((line) => line.split(';'));

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
  const userId = Number(db(`select id from "User" where email = '${user.email}'`));
  const marked = await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', {
    userId: adminId,
    member: true,
  });

  assert.equal(marked.status, 200, marked.text);
  db(`delete from "RevalleFinanceMember" where "userId" = ${userId}`);
  db(`delete from "RevalleAccountingMember" where "userId" in (${userId}, ${adminId})`);

  const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });

  assert.equal(imported.status, 200, imported.text);
  db('delete from "RateLimit"');

  accountant = await newAccount('contab');
  financeOnly = await newAccount('financeiro');
  both = await newAccount('ambos');
  outsider = await newAccount('terceiro');

  for (const [person, finance, accounting] of [
    [accountant, false, true],
    [financeOnly, true, false],
    [both, true, true],
  ]) {
    if (finance) {
      const res = await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', {
        userId: person.id,
        member: true,
      });

      assert.equal(res.status, 200, res.text);
    }

    if (accounting) {
      const res = await trpcAs(adminCookie, 'mutation', 'revalle.accounting.adminSetMember', {
        userId: person.id,
        isMember: true,
      });

      assert.equal(res.status, 200, res.text);
    }
  }
});

after(() => {
  for (const person of [accountant, financeOnly, both]) {
    if (person) {
      db(`delete from "RevalleAccountingMember" where "userId" = ${person.id}`);
      db(`delete from "RevalleFinanceMember" where "userId" = ${person.id}`);
    }
  }
});

sessionTest('pendingCounts: 401 sem sessão; null no perfil que a pessoa não tem', async () => {
  const anonymous = await trpcAs('', 'query', 'revalle.invoice.pendingCounts');

  assert.equal(anonymous.status, 401, anonymous.text);

  for (const cookie of [userCookie, outsider.cookie]) {
    assert.deepEqual(await pendingCounts(cookie), { finance: null, accounting: null });
  }

  const accountantCounts = await pendingCounts(accountant.cookie);
  const financeCounts = await pendingCounts(financeOnly.cookie);
  const bothCounts = await pendingCounts(both.cookie);
  const adminCounts = await pendingCounts(adminCookie);

  assert.equal(accountantCounts.finance, null);
  assert.ok(Number.isInteger(accountantCounts.accounting), JSON.stringify(accountantCounts));
  assert.equal(financeCounts.accounting, null);
  assert.ok(Number.isInteger(financeCounts.finance), JSON.stringify(financeCounts));
  assert.ok(
    Number.isInteger(bothCounts.finance) && Number.isInteger(bothCounts.accounting),
    JSON.stringify(bothCounts),
  );
  // O admin só vê o contador do perfil em que foi marcado (rsadmin é do Financeiro, nunca da Contabilidade).
  assert.equal(adminCounts.accounting, null);
  assert.ok(Number.isInteger(adminCounts.finance), JSON.stringify(adminCounts));
});

sessionTest('pendingCounts: sobe ao enviar, desce ao validar e ao aprovar, e cada fila só mexe na sua', async () => {
  const base = {
    accountant: (await pendingCounts(accountant.cookie)).accounting,
    finance: (await pendingCounts(financeOnly.cookie)).finance,
  };
  const doc = await newInvoice('contagem');

  assert.equal((await pendingCounts(accountant.cookie)).accounting, base.accountant + 1);
  assert.equal((await pendingCounts(financeOnly.cookie)).finance, base.finance + 1);
  assert.deepEqual(await pendingCounts(both.cookie), { finance: base.finance + 1, accounting: base.accountant + 1 });

  // O número do menu é o da fila da página (mesma consulta) e o aviso do admin é o da Contabilidade.
  assert.equal((await find(accountant.cookie, { accounting: 'pendentes' })).count, base.accountant + 1);
  assert.equal((await find(financeOnly.cookie, { finance: 'pendentes' })).count, base.finance + 1);

  const listed = await trpcAs(adminCookie, 'query', 'revalle.finance.adminListUsers', {});

  assert.equal(listed.status, 200, listed.text);
  assert.equal(data(listed).accountingPendingCount, base.accountant + 1);

  const validated = await validate(doc.id);

  assert.equal(validated.status, 200, validated.text);
  assert.equal((await pendingCounts(accountant.cookie)).accounting, base.accountant);
  assert.equal(
    (await pendingCounts(financeOnly.cookie)).finance,
    base.finance + 1,
    'validar mexeu na fila do Financeiro',
  );
  assert.equal((await find(accountant.cookie, { accounting: 'pendentes' })).count, base.accountant);

  const approved = await approve(doc.id);

  assert.equal(approved.status, 200, approved.text);
  assert.equal((await pendingCounts(financeOnly.cookie)).finance, base.finance);
  assert.equal(
    (await pendingCounts(accountant.cookie)).accounting,
    base.accountant,
    'aprovar mexeu na fila da Contabilidade',
  );
  assert.deepEqual(await pendingCounts(both.cookie), { finance: base.finance, accounting: base.accountant });
  assert.equal(
    data(await trpcAs(adminCookie, 'query', 'revalle.finance.adminListUsers', {})).accountingPendingCount,
    base.accountant,
  );
});

sessionTest(
  'pendingCounts: NF recusada, substituída e excluída saem das duas filas; a concluída sem validação fica',
  async () => {
    const read = async () => ({
      accounting: (await pendingCounts(accountant.cookie)).accounting,
      finance: (await pendingCounts(financeOnly.cookie)).finance,
    });
    const base = await read();

    const rejected = await newInvoice('recusada');
    const superseded = await newInvoice('substituida');
    const deleted = await newInvoice('excluida');

    assert.deepEqual(await read(), { accounting: base.accounting + 3, finance: base.finance + 3 });

    await gate(rejected.recipients[0].token);

    const refusal = await trpc('recipient.rejectDocumentWithToken', {
      token: rejected.recipients[0].token,
      documentId: rejected.documentId,
      reason: 'Teste',
    });

    assert.equal(refusal.status, 200, refusal.text);
    assert.deepEqual(await read(), { accounting: base.accounting + 2, finance: base.finance + 2 }, 'recusada');

    db(
      `update "RevalleInvoiceClassification" set "financeStatus" = 'SUPERSEDED' where "envelopeId" = '${superseded.id}'`,
    );
    assert.deepEqual(await read(), { accounting: base.accounting + 1, finance: base.finance + 1 }, 'substituída');

    db(`update "Envelope" set "deletedAt" = now() where id = '${deleted.id}'`);
    assert.deepEqual(await read(), base, 'excluída');

    // Concluída e sem validação: continua esperando a Contabilidade (validar não segura a conclusão); o Financeiro já agiu.
    const completed = await newInvoice('concluida');

    assert.deepEqual(await read(), { accounting: base.accounting + 1, finance: base.finance + 1 });
    await sign(completed, 0);
    assert.equal((await approve(completed.id)).status, 200);
    assert.equal(await waitStatus(completed.id, 'COMPLETED'), 'COMPLETED');
    assert.deepEqual(await read(), { accounting: base.accounting + 1, finance: base.finance }, 'concluída');

    const validated = await validate(completed.id);

    assert.equal(validated.status, 200, validated.text);
    assert.deepEqual(await read(), base, 'concluída e validada');
  },
);

sessionTest('lista: centro, validação e quem validou; filtro da Contabilidade respeita a visibilidade', async () => {
  const waiting = await newInvoice('lista-aguarda');
  const validated = await newInvoice('lista-validada', { center: '201' });
  const noCenter = await newInvoice('lista-sem-centro');

  db(
    `update "RevalleInvoiceClassification" set "costCenterCode" = null, "costCenterById" = null, "costCenterAt" = null where "envelopeId" = '${noCenter.id}'`,
  );
  assert.equal((await validate(validated.id)).status, 200);

  const rowOf = (list, doc) => list.data.find((row) => row.id === doc.id);
  const everything = await find(accountant.cookie);
  const pending = await find(accountant.cookie, { accounting: 'pendentes' });
  const done = await find(accountant.cookie, { accounting: 'validadas' });
  const all = await find(accountant.cookie, { accounting: 'todas' });

  // Linha: centro por extenso, validação e quem validou (nome congelado), só depois da validação.
  assert.equal(rowOf(everything, waiting).costCenterLabel, '101 – Puxada');
  assert.equal(rowOf(everything, waiting).costCenterValidatedAt, null);
  assert.equal(rowOf(everything, waiting).costCenterValidatedBy, null);
  assert.equal(rowOf(everything, validated).costCenterLabel, '201 – Armazém');
  assert.ok(rowOf(everything, validated).costCenterValidatedAt);
  assert.equal(rowOf(everything, validated).costCenterValidatedBy, accountant.name);
  assert.equal(rowOf(everything, noCenter).costCenterCode, null);
  assert.equal(rowOf(everything, noCenter).costCenterLabel, null);

  // Fila da Contabilidade: a que espera e a sem centro; a validada não. "Validadas" é o contrário; "todas" não filtra.
  assert.ok(rowOf(pending, waiting), 'a NF que espera não está na fila');
  assert.ok(rowOf(pending, noCenter), 'a NF sem centro também espera a Contabilidade');
  assert.equal(rowOf(pending, validated), undefined, 'a validada está na fila');
  assert.ok(rowOf(done, validated), 'a validada não está em "validadas"');
  assert.equal(rowOf(done, waiting), undefined);
  assert.equal(rowOf(done, noCenter), undefined);
  assert.ok(rowOf(all, waiting) && rowOf(all, validated) && rowOf(all, noCenter));
  assert.equal(all.count, everything.count);

  // Quem não é da Contabilidade só filtra o que já via: o dono vê a dele; um terceiro não vê nada delas.
  const ownerPending = await find(userCookie, { accounting: 'pendentes' });

  assert.ok(rowOf(ownerPending, waiting), 'o dono não vê a própria NF na fila');
  assert.equal(rowOf(ownerPending, validated), undefined);

  const outsiderAll = await find(outsider.cookie, { accounting: 'todas' });

  assert.equal(rowOf(outsiderAll, waiting), undefined);
  assert.equal(rowOf(outsiderAll, validated), undefined);
  assert.equal((await find(outsider.cookie, { accounting: 'pendentes' })).count, 0);

  // A página abre com as colunas novas (a fila padrão é escolhida no navegador: ver o teste do fim).
  const page = await fetchIdempotent(
    `${BASE_URL}/notas-fiscais?contabilidade=todas`,
    { headers: { Cookie: accountant.cookie } },
    async (res) => ({ status: res.status, text: await res.text() }),
  );

  assert.equal(page.status, 200);
  assert.ok(page.text.includes('Validação da Contabilidade'), 'coluna e filtro da Contabilidade ausentes');
  assert.ok(page.text.includes('Centro de custo'), 'coluna do centro de custo ausente');
});

sessionTest(
  'planilha: quatro colunas novas depois de aprovado_por, filtro, nome congelado e vazio sem validação',
  async () => {
    const waiting = await newInvoice('csv-aguarda');
    const validated = await newInvoice('csv-validada', { center: '401' });
    const noCenter = await newInvoice('csv-sem-centro');

    db(
      `update "RevalleInvoiceClassification" set "costCenterCode" = null, "costCenterById" = null, "costCenterAt" = null where "envelopeId" = '${noCenter.id}'`,
    );
    assert.equal((await validate(validated.id)).status, 200);

    // O nome congelado vale: trocar o nome da pessoa depois não muda a planilha.
    db(`update "User" set name = 'Nome Novo ${RUN}' where id = ${accountant.id}`);

    try {
      const all = await csv(accountant.cookie, '?contabilidade=todas');

      assert.equal(all.status, 200, all.text);
      assert.ok(all.text.startsWith('﻿id;titulo;'), 'a planilha perdeu o BOM ou as primeiras colunas');

      const [header, ...rows] = csvRows(all.text);

      assert.deepEqual(header.slice(12), [
        'link',
        'financeiro',
        'aprovado_por',
        'centro_custo',
        'nome_centro_custo',
        'validacao_contabilidade',
        'validado_por',
      ]);
      assert.equal(header.length, 19);

      const rowOf = (doc) => rows.find((cells) => cells[1] === doc.title);

      assert.equal(rowOf(waiting).length, 19);
      assert.deepEqual(rowOf(waiting).slice(15), ['101', 'Puxada', 'Aguardando validação', '']);
      assert.deepEqual(rowOf(validated).slice(15), ['401', 'Vendas', 'Validado', accountant.name]);
      assert.deepEqual(rowOf(noCenter).slice(15), ['', '', 'Sem centro de custo', '']);

      // Filtro: `contabilidade=pendentes` traz as que esperam e não a validada; `validadas`, o contrário.
      const pendingRows = csvRows((await csv(accountant.cookie, '?contabilidade=pendentes')).text).slice(1);
      const doneRows = csvRows((await csv(accountant.cookie, '?contabilidade=validadas')).text).slice(1);

      assert.ok(pendingRows.some((cells) => cells[1] === waiting.title));
      assert.ok(pendingRows.some((cells) => cells[1] === noCenter.title));
      assert.ok(!pendingRows.some((cells) => cells[1] === validated.title), 'a validada saiu na fila');
      assert.ok(doneRows.some((cells) => cells[1] === validated.title));
      assert.ok(!doneRows.some((cells) => cells[1] === waiting.title));
      assert.ok(pendingRows.every((cells) => cells[17] !== 'Validado'));
      assert.ok(doneRows.every((cells) => cells[17] === 'Validado'));

      assert.equal((await csv(accountant.cookie, '?contabilidade=qualquer')).status, 400);

      // Quem não é da Contabilidade recebe as mesmas colunas, só das NFs que já via.
      const ownerRows = csvRows((await csv(userCookie, '?contabilidade=todas')).text);
      const outsiderRows = csvRows((await csv(outsider.cookie, '?contabilidade=todas')).text);

      assert.equal(ownerRows[0].length, 19);
      assert.ok(ownerRows.some((cells) => cells[1] === waiting.title));
      assert.ok(!outsiderRows.some((cells) => cells[1] === waiting.title));
    } finally {
      db(`update "User" set name = '${accountant.name}' where id = ${accountant.id}`);
    }
  },
);

sessionTest('Baixar PDF: anexo com o nome do arquivo, prévia sem anexo, 404 sem acesso', async () => {
  const doc = await newInvoice('baixar');
  const url = `${BASE_URL}/notas-fiscais/${doc.id}/pdf/${doc.itemId}`;
  const get = (target, cookie) =>
    fetchIdempotent(target, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' }, async (res) => ({
      status: res.status,
      headers: res.headers,
      body: Buffer.from(await res.arrayBuffer()),
    }));

  for (const cookie of [accountant.cookie, financeOnly.cookie, userCookie]) {
    const download = await get(`${url}?download=1`, cookie);

    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/pdf');
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.match(download.headers.get('content-disposition') ?? '', /danfe-baixar\.pdf/);
    assert.equal(download.body.subarray(0, 4).toString(), '%PDF');
  }

  // Sem `download`, a prévia de sempre: PDF sem cabeçalho de anexo.
  const preview = await get(url, accountant.cookie);

  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-disposition'), null);

  // Sem acesso à NF: 404, com ou sem `download`. Sem sessão não entrega o arquivo.
  assert.equal((await get(`${url}?download=1`, outsider.cookie)).status, 404);
  assert.equal((await get(url, outsider.cookie)).status, 404);
  assert.notEqual((await get(`${url}?download=1`, '')).status, 200);

  // A página da NF traz o botão (link com `download=1`) para quem vê.
  const page = await fetchIdempotent(
    `${BASE_URL}/notas-fiscais/${doc.id}`,
    { headers: { Cookie: accountant.cookie } },
    async (res) => ({ status: res.status, text: await res.text() }),
  );

  assert.equal(page.status, 200);
  assert.ok(page.text.includes(`/notas-fiscais/${doc.id}/pdf/${doc.itemId}?download=1`), 'botão Baixar PDF ausente');
  assert.ok(page.text.includes('Baixar PDF'));
});

sessionTest('Baixar PDF: a NF concluída sai com _signed no nome', async () => {
  const doc = await newInvoice('baixar-concluida');

  await sign(doc, 0);
  assert.equal((await approve(doc.id)).status, 200);
  assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');

  const res = await fetchIdempotent(
    `${BASE_URL}/notas-fiscais/${doc.id}/pdf/${doc.itemId}?download=1`,
    { headers: { Cookie: financeOnly.cookie } },
    async (response) => ({ status: response.status, disposition: response.headers.get('content-disposition') }),
  );

  assert.equal(res.status, 200);
  assert.match(res.disposition ?? '', /danfe-baixar-concluida_signed\.pdf/);
});

sessionTest(
  'Ver documento: quem assinou abre o PDF enquanto o documento não conclui, também esperando o Financeiro',
  async () => {
    const doc = await newInvoice('ver-documento', { signers: 2 });
    const [first, second] = doc.recipients;
    const completePage = (token) =>
      fetchIdempotent(`${BASE_URL}/sign/${token}/complete`, {}, async (res) => ({
        status: res.status,
        text: await res.text(),
      }));
    const fileOf = (token) =>
      fetchIdempotent(`${BASE_URL}${SIGNING_FILE(token, doc.itemId)}`, {}, async (res) => ({
        status: res.status,
        type: res.headers.get('content-type'),
        head: Buffer.from(await res.arrayBuffer())
          .subarray(0, 4)
          .toString(),
      }));

    // Um assinou, o outro não: o documento está pendente.
    await sign(doc, 0);

    const pending = await completePage(first.token);

    assert.equal(pending.status, 200);
    assert.ok(pending.text.includes('Ver documento'), 'a página de conclusão não tem "Ver documento"');
    assert.ok(pending.text.includes(SIGNING_FILE(first.token, doc.itemId)), 'o link não aponta para o PDF do token');
    assert.ok(pending.text.includes('target="_blank"'), 'o link não abre em nova aba');
    assert.deepEqual(await fileOf(first.token), { status: 200, type: 'application/pdf', head: '%PDF' });

    // Os dois assinaram: a NF fica esperando o Financeiro e o link continua.
    await sign(doc, 1);
    await sleep(1000);
    assert.equal(status(doc.id), 'PENDING');

    const awaiting = await completePage(second.token);

    assert.ok(awaiting.text.includes('Aguardando aprovação do Financeiro'), awaiting.text.slice(0, 200));
    assert.ok(awaiting.text.includes('Ver documento'));
    assert.deepEqual(await fileOf(second.token), { status: 200, type: 'application/pdf', head: '%PDF' });

    // O Financeiro aprova, o documento conclui e a página passa a oferecer o download no lugar.
    assert.equal((await approve(doc.id)).status, 200);
    assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');

    const completed = await completePage(first.token);

    assert.equal(completed.status, 200);
    assert.ok(!completed.text.includes('Ver documento'), 'concluído ainda oferece "Ver documento"');
    assert.ok(completed.text.includes('lucide-download'), 'concluído deveria oferecer o download');
  },
);

sessionTest('Ver documento: versão substituída não abre o PDF nem mostra o link', async () => {
  const doc = await newInvoice('ver-substituida');
  const [signer] = doc.recipients;

  await sign(doc, 0);

  const before = await fetchIdempotent(`${BASE_URL}/sign/${signer.token}/complete`, {}, (res) => res.text());

  assert.ok(before.includes('Ver documento'), 'o link deveria existir antes da substituição');

  const changed = await changeAccount(doc.id);

  assert.equal(changed.status, 200, changed.text);
  assert.equal(invoiceRow(doc.id, '"financeStatus"'), 'SUPERSEDED');

  const file = await fetchIdempotent(`${BASE_URL}${SIGNING_FILE(signer.token, doc.itemId)}`, {}, async (res) => ({
    status: res.status,
    type: res.headers.get('content-type'),
  }));

  assert.equal(file.status, 403, 'a versão substituída ainda entrega o PDF');
  assert.notEqual(file.type, 'application/pdf');

  const after = await fetchIdempotent(`${BASE_URL}/sign/${signer.token}/complete`, {}, (res) => res.text());

  assert.ok(after.includes(GATE_MESSAGE), 'a versão substituída deveria mostrar o aviso da nova versão');
  assert.ok(!after.includes('Ver documento'));
});

test('navegador: contador do menu, fila de abertura e botão View (na imagem do Playwright)', async (t) => {
  if (!userCookie || !adminCookie) {
    t.skip('credenciais de sessão não informadas');

    return;
  }

  if (!hasPlaywrightImage()) {
    t.skip(`imagem ${PLAYWRIGHT_IMAGE} ausente no Docker (docker pull ${PLAYWRIGHT_IMAGE})`);

    return;
  }

  // Quem assina uma NF que espera o Financeiro e tem conta: o remetente (que também é destinatário) e uma pessoa de fora.
  // O e-mail do remetente (admin@hml.local) não é de um domínio da empresa: o destinatário vai para o banco, como nos
  // outros testes que trocam o e-mail de quem assina.
  const created = await newInvoice('navegador-dono');

  db(`update "Recipient" set email = '${user.email}' where "envelopeId" = '${created.id}'`);

  const ownSigned = loadVersion(created.id);
  const outsiderSigned = await newInvoice('navegador-destinatario', { recipientEmails: [outsider.email] });

  await sign(ownSigned, 0);
  await sign(outsiderSigned, 0);
  assert.equal(status(ownSigned.id), 'PENDING');
  assert.equal(status(outsiderSigned.id), 'PENDING');

  // Uma validada garante que "todas" tem linha com "Validado".
  const validated = await newInvoice('navegador-validada');

  assert.equal((await validate(validated.id)).status, 200);

  const teamUrl = db(
    `select t.url from "Team" t join "Envelope" e on e."teamId" = t.id where e.id = '${ownSigned.id}'`,
  );
  const expected = {
    accountant: await pendingCounts(accountant.cookie),
    financeOnly: await pendingCounts(financeOnly.cookie),
    both: await pendingCounts(both.cookie),
  };
  const payload = {
    baseUrl: BASE_URL,
    teamUrl,
    expected,
    cookies: {
      accountant: accountant.cookie,
      financeOnly: financeOnly.cookie,
      both: both.cookie,
      outsider: outsider.cookie,
      owner: userCookie,
    },
    own: { id: ownSigned.id, title: ownSigned.title },
    received: { id: outsiderSigned.id, title: outsiderSigned.title, token: outsiderSigned.recipients[0].token },
    validatedTitle: validated.title,
  };

  // O script do navegador escreve uma linha por conferência (`ok ...` ou `FALHOU ...`) e sai com código 1 se alguma falhar.
  // REVSIGN_VISIBILITY_SHOTS: pasta (já criada) para os prints das telas, quando alguém quiser olhar.
  const runBrowser = async (extra) => {
    const result = await runBrowserScript({
      script: 'invoice-visibility.browser.mjs',
      payload: { ...payload, ...extra },
      shotDir: process.env.REVSIGN_VISIBILITY_SHOTS,
      timeout: 240_000,
    });

    t.diagnostic(result.stdout);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  };

  await runBrowser({ phase: 'main' });

  // Aviso do admin: sem ninguém na Contabilidade e com nota esperando a validação, a tela avisa com o número; com alguém
  // marcado, não avisa. Os membros saem do banco por instantes e voltam pela rota do admin, mesmo se o teste falhar.
  const members = db('select "userId" from "RevalleAccountingMember"').split('\n').filter(Boolean).map(Number);

  db('delete from "RevalleAccountingMember"');

  try {
    const listed = data(await trpcAs(adminCookie, 'query', 'revalle.finance.adminListUsers', {}));

    assert.equal(listed.accountingMemberCount, 0);
    assert.ok(listed.accountingPendingCount > 0, 'o teste precisa de nota esperando a Contabilidade');
    await runBrowser({ phase: 'admin-alert', adminCookie, adminPending: listed.accountingPendingCount });
  } finally {
    for (const userId of members) {
      const restored = await trpcAs(adminCookie, 'mutation', 'revalle.accounting.adminSetMember', {
        userId,
        isMember: true,
      });

      assert.equal(restored.status, 200, restored.text);
    }
  }

  await runBrowser({ phase: 'admin-quiet', adminCookie });
});
