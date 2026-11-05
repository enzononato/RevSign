// Fase 8, Task 2: alerta de nota duplicada. Uma NF é "possível duplicada" quando OUTRA NF viva (enviada, pendente ou
// concluída, sem recusa, cancelamento, exclusão nem substituição) tem uma chave de acesso em comum ou o mesmo arquivo, e
// ela mesma também está viva. A IA é o servidor FALSO na fronteira de rede (scripts/revalle/tests/fake-gemini.mjs, subido
// com revalle/deploy/compose.test.yml); sem ele (e sem GEMINI_API_KEY no app), os casos de IA são pulados. Nenhuma chamada
// ao Gemini de verdade.
//
//   - mesma chave com outro layout (arquivo diferente) e mesmo arquivo sem chave (NFS-e): `invoice.get` traz `duplicates`
//     com data, remetente e situação, e nada de título nem id;
//   - a chave do texto só é guardada se for válida; a que a IA leu numa NF escaneada soma-se (inclusive pelo cache), e a
//     inválida é ignorada;
//   - não acusa: rascunho de outra pessoa; a outra NF recusada (por destinatário ou pelo envelope), cancelada, excluída ou
//     substituída; a nova versão não acusa a anterior e continua acusando uma terceira NF;
//   - a NF substituída, recusada, cancelada ou excluída não mostra alerta dela mesma;
//   - o envio pela API com duplicada não é bloqueado;
//   - lista (Financeiro e Contabilidade veem a marca, o colaborador comum não), página da NF (título e link para o
//     Financeiro; sem título nem link para o dono; nada para quem só assina), planilha (`chave_acesso`, `possivel_duplicada`);
//   - o alerta some quando a outra NF é recusada;
//   - navegador: o alerta no diálogo de envio (computador e celular), o botão Enviar travado até a confirmação, inclusive
//     quando a chave da IA chega com o diálogo aberto, e o aviso sem a confirmação no cartão do dono.
//
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN, colaborador comum), REVSIGN_ADMIN_* (rsadmin: ADMIN e Financeiro) e
// REVSIGN_SENDER_API_TOKEN (token do mesmo rsadmin: a "outra pessoa" que envia). Cria duas contas novas a cada execução
// (Contabilidade e alguém que só assina). Este teste SUBSTITUI a lista de contas da stack local pela dele e apaga os
// limites `RateLimit`. Chaves e arquivos são novos a cada execução (as notas de outras suítes não entram na conta).
// Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

import {
  api,
  appLogs,
  assertNoPaidGeminiCalls,
  BASE_URL,
  chooseInvoice,
  createConfirmedAccount,
  createEnvelope,
  db,
  distribute,
  drawingPng,
  fetchIdempotent,
  hasPlaywrightImage,
  PLAYWRIGHT_IMAGE,
  retryCreateOnStaleSocket,
  runBrowserScript,
  signIn,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const FAKE_URL = (process.env.REVSIGN_FAKE_GEMINI_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const APP_CONTAINER = 'revsign-hml-documenso-1';
const SHOT_DIR = process.env.REVSIGN_F8_SHOTS;

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };
const SENDER_TOKEN = process.env.REVSIGN_SENDER_API_TOKEN;

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = `Duplicada-F8-${RUN}!`;
const REASON = 'Conta de serviço, não de material.';

const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
].join('\n');

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-duplicada-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flat = (text) => text.replace(/<!-- -->/g, '').replace(/\s+/g, ' ');

let userCookie;
let adminCookie;
let accountant;
let signer;
let aiMode = 'off';
let skipReason;
let teamUrl;

const data = (res) => res.body?.result?.data?.json;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia' }).format(new Date());

// ---------- Chaves de acesso fictícias e válidas ----------

const digitsOf = (text) => [...text].map(Number);

const cnpjCheck = (digits) => {
  let weight = digits.length - 7;
  let sum = 0;

  for (const digit of digits) {
    sum += digit * weight;
    weight = weight === 2 ? 9 : weight - 1;
  }

  const rest = sum % 11;

  return rest < 2 ? 0 : 11 - rest;
};

const randomDigits = (length) =>
  Array.from({ length }, () => Math.floor(Math.random() * 10))
    .join('')
    .replace(/^0/, '7');

// UF 29, mês 2410, CNPJ novo (dígitos certos), modelo 55: uma chave que ninguém mais usou, com o dígito verificador certo.
const makeKey = (model = '55') => {
  const base = `${randomDigits(8)}0001`;
  const first = digitsOf(base);
  const cnpj = `${base}${cnpjCheck(first)}${cnpjCheck([...first, cnpjCheck(first)])}`;
  const first43 = `2924${'10'}${cnpj}${model}001${randomDigits(9)}1${randomDigits(8)}`;
  let sum = 0;
  let weight = 2;

  for (let index = 42; index >= 0; index -= 1) {
    sum += Number(first43[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }

  const rest = sum % 11;

  return `${first43}${rest < 2 ? 0 : 11 - rest}`;
};

assert.equal(makeKey().length, 44);

const wrongDigit = (key) => `${key.slice(0, 43)}${(Number(key[43]) + 1) % 10}`;
const spaced = (key) => key.replace(/(\d{4})(?=\d)/g, '$1 ');

// ---------- Documentos fictícios ----------

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

// DANFE com a chave. O layout "A" escreve a chave em grupos de 4; o "B" sem espaços e em outra ordem: a chave é a mesma
// e o arquivo é outro. `tag` deixa o arquivo único.
const danfe = (key, layout, tag) =>
  layout === 'A'
    ? textPdf([
        'DANFE - Documento Auxiliar da Nota Fiscal Eletrônica',
        '0 - Entrada   1 - Saída   Nº 000.012.345   Série 001',
        'Chave de Acesso',
        spaced(key),
        'Natureza da Operação: Venda de mercadoria adquirida de terceiros',
        'Emitente: Distribuidora Fictícia de Ferragens Ltda   CNPJ 12.345.678/0001-95',
        `Referência do teste: duplicada ${tag} ${RUN}`,
        'Valor Total da Nota: R$ 150,00',
      ])
    : textPdf([
        `Referência do teste: duplicada ${tag} ${RUN} (layout B)`,
        'Valor Total da Nota: R$ 150,00   ICMS: R$ 18,00',
        'Emitente: Distribuidora Fictícia de Ferragens Ltda   CNPJ 12.345.678/0001-95   Série 001',
        'DANFE - Documento Auxiliar da Nota Fiscal Eletrônica   Nº 12345',
        `Chave de acesso: ${key}`,
        'Natureza da Operação: Venda de mercadoria adquirida de terceiros',
        'Destinatário: Revalle Distribuidora (fictício)',
      ]);

// NFS-e: não tem chave de 44 dígitos.
const nfse = (tag) =>
  textPdf([
    'Prefeitura Municipal de Salvador (fictício)',
    'NFS-e - Nota Fiscal de Serviço Eletrônica   Número 2024000777',
    'Prestador: Manutenções Fictícias S/A   CNPJ 12.345.678/0001-95   Inscrição Municipal 998877',
    'Tomador: Revalle Distribuidora (fictício)',
    'Discriminação dos Serviços: manutenção preventiva de empilhadeiras',
    `Referência do teste: duplicada ${tag} ${RUN}`,
    'Valor dos Serviços: R$ 980,00   ISS retido: R$ 49,00',
  ]);

// "Escaneado": só uma imagem por página, nenhum texto. O título do PDF deixa o arquivo único.
const scanned = async (tag) => {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(Buffer.from(drawingPng().split(',')[1], 'base64'));
  const page = doc.addPage([595, 842]);

  page.drawImage(png, { x: 40, y: 500, width: 500, height: 170 });
  doc.setTitle(`Digitalização duplicada ${tag} ${RUN}`);

  return Buffer.from(await doc.save());
};

// Devolução: traz a chave PRÓPRIA no cabeçalho e, nas informações complementares, a da nota original que ela cita.
const devolucao = (ownKey, citedKey, tag) =>
  textPdf([
    'DANFE - Documento Auxiliar da Nota Fiscal Eletrônica',
    '0 - Entrada   1 - Saída   Nº 000.054.321   Série 001',
    'Chave de Acesso',
    spaced(ownKey),
    'Natureza da Operação: Devolução de mercadoria',
    'Emitente: Distribuidora Fictícia de Ferragens Ltda   CNPJ 12.345.678/0001-95',
    `Referência do teste: duplicada ${tag} ${RUN}`,
    'Valor Total da Nota: R$ 90,00',
    'Informações complementares',
    `NF-e referenciada: ${spaced(citedKey)}`,
  ]);

// CT-e (modelo 57): a chave própria no cabeçalho e a da NF-e transportada nos documentos originários.
const dacte = (ownKey, citedKey, tag) =>
  textPdf([
    'DACTE - Documento Auxiliar do Conhecimento de Transporte Eletrônico',
    'Nota fiscal de serviço de transporte   CNPJ 12.345.678/0001-95',
    'Chave de acesso',
    spaced(ownKey),
    `Referência do teste: duplicada ${tag} ${RUN}`,
    'Valor total da prestação: R$ 200,00   ICMS: R$ 36,00',
    'Documentos originários',
    `NF-e ${spaced(citedKey)}`,
  ]);

const writeFixture = (name, bytes) => {
  const file = path.join(tmp, name);

  writeFileSync(file, bytes);

  return file;
};

// ---------- Banco ----------

const sqlText = (value) => value.replace(/'/g, "''");
const columnOf = (envelopeId, column) =>
  db(`select ${column} from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`);
const accessKeysOf = (envelopeId) => columnOf(envelopeId, `"accessKeys"::text`);
const senderLabel = (email) =>
  db(`select coalesce(nullif(trim(name), ''), email) from "User" where email = '${sqlText(email)}'`);

// Põe o estado no banco, roda `fn` e devolve o original, mesmo se falhar.
const withState = async (id, { apply, restore }, fn) => {
  db(apply(id));

  try {
    return await fn();
  } finally {
    db(restore(id));
  }
};

const STATES = {
  'destinatário recusou': {
    apply: (id) => `update "Recipient" set "signingStatus" = 'REJECTED' where "envelopeId" = '${id}'`,
    restore: (id) => `update "Recipient" set "signingStatus" = 'NOT_SIGNED' where "envelopeId" = '${id}'`,
  },
  'documento recusado': {
    apply: (id) => `update "Envelope" set status = 'REJECTED' where id = '${id}'`,
    restore: (id) => `update "Envelope" set status = 'PENDING' where id = '${id}'`,
  },
  'documento cancelado': {
    apply: (id) => `update "Envelope" set status = 'CANCELLED' where id = '${id}'`,
    restore: (id) => `update "Envelope" set status = 'PENDING' where id = '${id}'`,
  },
  'documento excluído': {
    apply: (id) => `update "Envelope" set "deletedAt" = now() where id = '${id}'`,
    restore: (id) => `update "Envelope" set "deletedAt" = null where id = '${id}'`,
  },
  'versão substituída': {
    apply: (id) =>
      `update "RevalleInvoiceClassification" set "financeStatus" = 'SUPERSEDED' where "envelopeId" = '${id}'`,
    restore: (id) =>
      `update "RevalleInvoiceClassification" set "financeStatus" = 'PENDING_APPROVAL' where "envelopeId" = '${id}'`,
  },
};

// ---------- Servidor falso do Gemini ----------

const fake = async (route, body) => {
  const res = await fetch(`${FAKE_URL}${route}`, body ? { method: 'POST', body: JSON.stringify(body) } : {});

  assert.equal(res.status, 200, `fake ${route}: ${res.status}`);

  return res.json();
};
const calls = () => fake('/__calls');
const program = (input) => fake('/__program', { mode: 'ok', accountCode: '2.1.03', ...input });

const containerHasEnv = (name) => {
  try {
    execFileSync('docker', ['exec', APP_CONTAINER, 'sh', '-c', `test -n "$${name}"`], { stdio: 'ignore' });

    return true;
  } catch {
    return false;
  }
};
const containerEnv = (name) =>
  execFileSync('docker', ['exec', APP_CONTAINER, 'sh', '-c', `printf %s "$${name}"`], { encoding: 'utf8' });

// ---------- Quem é quem ----------

const people = () => ({
  user: { token: process.env.REVSIGN_API_TOKEN, cookie: userCookie, email: user.email },
  sender: { token: SENDER_TOKEN, cookie: adminCookie, email: admin.email },
});

const invoice = (cookie, kind, name, input) => trpcAs(cookie, kind, `revalle.invoice.${name}`, input);

const getState = async (cookie, envelopeId) => {
  const res = await invoice(cookie, 'query', 'get', { envelopeId });

  assert.equal(res.status, 200, res.text);

  return data(res);
};
const waitSettled = async (cookie, envelopeId, timeoutMs = 20_000) => {
  const deadline = performance.now() + timeoutMs;
  let state = await getState(cookie, envelopeId);

  while (state.suggestionStatus === 'PENDING' && performance.now() < deadline) {
    await sleep(400);
    state = await getState(cookie, envelopeId);
  }

  return state;
};
const duplicatesOf = async (cookie, envelopeId) => (await getState(cookie, envelopeId)).duplicates;

// Rascunho de NF de `who` ('user' ou 'sender'), já classificado e com a sugestão resolvida.
const newDraft = async (who, bytes, label, { recipient } = {}) => {
  const owner = people()[who];
  const title = `[TESTE NF] duplicada ${label} ${RUN}`;
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({
      recipients: [{ email: recipient ?? `dup-${label}-${RUN}@revalle.com.br` }],
      pdf: writeFixture(`${label}.pdf`, bytes),
      title,
      apiToken: owner.token,
    }),
  );

  assert.equal(created.status, 200, created.text);

  const classified = await invoice(owner.cookie, 'mutation', 'classify', { envelopeId: created.id });

  assert.equal(classified.status, 200, classified.text);

  return { id: created.id, title, owner, label };
};

const draftNf = async (who, bytes, label, options) => {
  const doc = await newDraft(who, bytes, label, options);
  const state = await waitSettled(doc.owner.cookie, doc.id);

  assert.equal(state.isInvoice, 'YES', `${label}: ${JSON.stringify(state)}`);

  return doc;
};

const sendNf = async (doc) => {
  const chosen = await chooseInvoice({ cookie: doc.owner.cookie, envelopeId: doc.id });

  assert.equal(chosen.status, 200, chosen.text);

  const recipients = await distribute(doc.id, { apiToken: doc.owner.token });

  assert.ok(recipients.length >= 1, `${doc.label}: o envio não devolveu destinatários`);
  assert.equal(db(`select status from "Envelope" where id = '${doc.id}'`), 'PENDING');

  return doc;
};

// Documento com vários arquivos (a criação da API v2 aceita mais de um em `files`). Devolve o envelope (com os itens).
const newEnvelopeWithFiles = async (files, label) => {
  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title: `[TESTE NF] duplicada ${label} ${RUN}`,
      type: 'DOCUMENT',
      meta: { distributionMethod: 'NONE' },
      recipients: [
        {
          role: 'SIGNER',
          name: 'Teste',
          email: `dup-${label}-${RUN}@revalle.com.br`,
          fields: [{ type: 'SIGNATURE', page: 1, positionX: 10, positionY: 80, width: 30, height: 8 }],
        },
      ],
    }),
  );

  for (const [name, bytes] of files) {
    form.append('files', new File([bytes], name, { type: 'application/pdf' }));
  }

  const created = await fetch(`${BASE_URL}/api/v2-beta/envelope/create`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` },
    body: form,
  });
  const body = await created.json();

  assert.equal(created.status, 200, JSON.stringify(body));

  return (await api('GET', `/envelope/${body.id}`)).body;
};

const sentNf = async (who, bytes, label, options) => sendNf(await draftNf(who, bytes, label, options));

// ---------- Páginas, lista e planilha ----------

const html = (cookie, route) =>
  fetchIdempotent(
    `${BASE_URL}${route}`,
    { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' },
    async (res) => ({ status: res.status, text: await res.text() }),
  );

const findRow = async (cookie, envelopeId) => {
  for (let page = 1; page <= 30; page += 1) {
    const res = await invoice(cookie, 'query', 'find', { from: today(), perPage: 100, page });

    assert.equal(res.status, 200, res.text);

    const body = data(res);
    const row = body.data.find((candidate) => candidate.id === envelopeId);

    if (row || page >= body.totalPages) {
      return row;
    }
  }

  return undefined;
};

const csvRow = async (cookie, envelopeId) => {
  const res = await fetchIdempotent(
    `${BASE_URL}/notas-fiscais/csv?de=${today()}`,
    { headers: { Cookie: cookie } },
    async (r) => ({
      status: r.status,
      text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer()),
    }),
  );

  assert.equal(res.status, 200, res.text.slice(0, 300));

  const [header, ...lines] = res.text.slice(1).split('\r\n').filter(Boolean);
  const line = lines.find((candidate) => candidate.startsWith(`${envelopeId};`));

  return { header: header.split(';'), cells: line?.split(';') };
};

// Os links `href` que levam ao `data-testid` dado.
const hrefsOf = (text, testId) =>
  [...text.matchAll(new RegExp(`<a\\b[^>]*data-testid="${testId}"[^>]*>`, 'g'))].map(
    (match) => /href="([^"]+)"/.exec(match[0])?.[1],
  );

// ---------- Casos ----------

const sessionTest = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie || !adminCookie || !SENDER_TOKEN) {
      t.skip('credenciais de sessão (REVSIGN_USER_*, REVSIGN_ADMIN_*, REVSIGN_SENDER_API_TOKEN) não informadas');

      return;
    }

    await fn(t);
  });
const aiTest = (name, fn) =>
  sessionTest(name, async (t) => {
    if (aiMode !== 'fake') {
      t.skip(skipReason ?? 'stack sem o servidor falso do Gemini');

      return;
    }

    await fn(t);
  });

before(async () => {
  if (!user.email || !user.password || !admin.email || !admin.password || !SENDER_TOKEN) {
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
  // O colaborador comum não é do Financeiro nem da Contabilidade, e o rsadmin é só do Financeiro.
  db(`delete from "RevalleFinanceMember" where "userId" = ${userId}`);
  db(`delete from "RevalleAccountingMember" where "userId" in (${userId}, ${adminId})`);

  const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });

  assert.equal(imported.status, 200, imported.text);
  db('delete from "RateLimit"');

  teamUrl = db(
    `select t.url from "Team" t join "Organisation" o on o.id = t."organisationId" where o."ownerUserId" = ${userId} limit 1`,
  );

  accountant = await createConfirmedAccount({
    email: `f8-contab-${RUN}@revalle.com.br`,
    name: 'Contabilidade Duplicada',
    password: PASSWORD,
  });
  signer = await createConfirmedAccount({
    email: `f8-assina-${RUN}@revalle.com.br`,
    name: 'Assina Duplicada',
    password: PASSWORD,
  });

  const accounting = await trpcAs(adminCookie, 'mutation', 'revalle.accounting.adminSetMember', {
    userId: accountant.id,
    isMember: true,
  });

  assert.equal(accounting.status, 200, accounting.text);

  const hasKey = containerHasEnv('GEMINI_API_KEY');
  const disabled = containerEnv('NEXT_PRIVATE_REVALLE_INVOICE_AI').trim().toLowerCase() === 'disabled';
  const fakeUp = await fetch(`${FAKE_URL}/__health`)
    .then((res) => res.ok)
    .catch(() => false);

  if (hasKey && !disabled && fakeUp) {
    aiMode = 'fake';
    await fake('/__reset', {});
  } else {
    skipReason =
      hasKey && !disabled
        ? `GEMINI_API_KEY definida, mas o servidor falso não responde em ${FAKE_URL}`
        : 'IA desligada na stack (sem GEMINI_API_KEY): suba com compose.test.yml para estes casos';
  }
});

after(async () => {
  if (accountant) {
    db(`delete from "RevalleAccountingMember" where "userId" = ${accountant.id}`);
  }

  if (aiMode === 'fake') {
    await fake('/__reset', {});
  }
});

const fx = {};

sessionTest('a chave do texto é guardada se for válida; sem chave (NFS-e) a lista fica vazia', async () => {
  const key = makeKey();
  const first = await draftNf('user', await danfe(key, 'A', 'chaves-a'), 'chaves-a');
  const second = await draftNf('user', await danfe(key, 'B', 'chaves-b'), 'chaves-b');
  const cte = await draftNf('user', await danfe(makeKey('57'), 'A', 'chaves-cte'), 'chaves-cte');
  const invalid = await draftNf('user', await danfe(wrongDigit(makeKey()), 'A', 'chaves-ruim'), 'chaves-ruim');
  const service = await draftNf('user', await nfse('chaves-nfse'), 'chaves-nfse');

  assert.equal(accessKeysOf(first.id), `{${key}}`);
  assert.equal(accessKeysOf(second.id), `{${key}}`, 'a chave escrita sem espaços não foi achada');
  assert.notEqual(
    columnOf(first.id, '"fileSha256"'),
    columnOf(second.id, '"fileSha256"'),
    'o layout B é o mesmo arquivo',
  );
  assert.match(accessKeysOf(cte.id), /^\{\d{20}57\d{22}\}$/, 'a chave de CT-e (modelo 57) não foi guardada');
  assert.equal(accessKeysOf(invalid.id), '{}', 'uma chave com o dígito errado foi guardada');
  assert.equal(accessKeysOf(service.id), '{}');
});

sessionTest('mesma chave com outro layout: o aviso traz data, remetente e situação, nunca título nem id', async () => {
  const key = makeKey();
  const first = await sentNf('sender', await danfe(key, 'A', 'chave-1'), 'chave-1');
  const second = await draftNf('user', await danfe(key, 'B', 'chave-2'), 'chave-2');

  fx.pair = { key, first, second };

  const duplicates = await duplicatesOf(second.owner.cookie, second.id);

  assert.equal(duplicates.length, 1, JSON.stringify(duplicates));
  assert.deepEqual(Object.keys(duplicates[0]).sort(), ['senderName', 'sentAt', 'status']);
  assert.equal(duplicates[0].status, 'PENDING');
  assert.equal(duplicates[0].senderName, senderLabel(admin.email));
  assert.ok(Math.abs(Date.parse(duplicates[0].sentAt) - Date.now()) < 10 * 60_000, duplicates[0].sentAt);

  const raw = JSON.stringify((await invoice(second.owner.cookie, 'query', 'get', { envelopeId: second.id })).body);

  assert.ok(!raw.includes(first.id), 'o estado traz o id da outra nota');
  assert.ok(!raw.includes(first.title), 'o estado traz o título da outra nota');

  // A que enviou ainda não é acusada por um rascunho, e o inverso vale: só nota enviada conta como "a outra".
  assert.deepEqual(await duplicatesOf(first.owner.cookie, first.id), [], 'um rascunho de outra pessoa acusou');
});

sessionTest('mesmo arquivo sem chave (NFS-e): acusa pelo hash do arquivo', async () => {
  const bytes = await nfse('mesmo-arquivo');
  const first = await sentNf('sender', bytes, 'servico-1');
  const second = await draftNf('user', bytes, 'servico-2');

  assert.equal(accessKeysOf(first.id), '{}');
  assert.equal(columnOf(first.id, '"fileSha256"'), columnOf(second.id, '"fileSha256"'));

  const duplicates = await duplicatesOf(second.owner.cookie, second.id);

  assert.equal(duplicates.length, 1, JSON.stringify(duplicates));
  assert.deepEqual(Object.keys(duplicates[0]).sort(), ['senderName', 'sentAt', 'status']);

  // Outra NFS-e, de outro arquivo, não acusa: sem chave, só o mesmo arquivo conta.
  const other = await draftNf('user', await nfse('arquivo-diferente'), 'servico-3');

  assert.deepEqual(await duplicatesOf(other.owner.cookie, other.id), []);
});

sessionTest('rascunho de outra pessoa não acusa; enviado, acusa', async () => {
  const key = makeKey();
  const draft = await draftNf('sender', await danfe(key, 'A', 'rascunho-1'), 'rascunho-1');
  const mine = await draftNf('user', await danfe(key, 'B', 'rascunho-2'), 'rascunho-2');

  assert.deepEqual(await duplicatesOf(mine.owner.cookie, mine.id), [], 'o rascunho de outra pessoa acusou');
  assert.deepEqual(await duplicatesOf(draft.owner.cookie, draft.id), []);

  await sendNf(draft);

  assert.equal((await duplicatesOf(mine.owner.cookie, mine.id)).length, 1, 'depois do envio, a outra nota não acusa');
});

sessionTest('a outra NF recusada, cancelada, excluída ou substituída não acusa; viva de novo, acusa', async () => {
  const key = makeKey();
  const other = await sentNf('sender', await danfe(key, 'A', 'outra-1'), 'outra-1');
  const mine = await draftNf('user', await danfe(key, 'B', 'outra-2'), 'outra-2');

  assert.equal((await duplicatesOf(mine.owner.cookie, mine.id)).length, 1, 'controle: a nota viva deveria acusar');

  for (const [name, state] of Object.entries(STATES)) {
    await withState(other.id, state, async () => {
      assert.deepEqual(await duplicatesOf(mine.owner.cookie, mine.id), [], `a outra NF com "${name}" ainda acusa`);
    });

    assert.equal(
      (await duplicatesOf(mine.owner.cookie, mine.id)).length,
      1,
      `depois de desfazer "${name}", a outra NF deveria acusar de novo`,
    );
  }

  // Exclusão de verdade (a NF pendente some do banco, como no upstream).
  const deleted = await api('POST', '/envelope/delete', { envelopeId: other.id }, { apiToken: other.owner.token });

  assert.equal(deleted.status, 200, deleted.text);
  assert.deepEqual(await duplicatesOf(mine.owner.cookie, mine.id), []);
});

sessionTest('a NF substituída, recusada, cancelada ou excluída não mostra o alerta dela mesma', async () => {
  const key = makeKey();
  const other = await sentNf('sender', await danfe(key, 'A', 'propria-1'), 'propria-1');
  const self = await sentNf('user', await danfe(key, 'B', 'propria-2'), 'propria-2');

  // O administrador lê o estado de qualquer NF, inclusive da excluída.
  assert.equal((await duplicatesOf(adminCookie, self.id)).length, 1, 'controle: a NF viva deveria acusar');

  for (const [name, state] of Object.entries(STATES)) {
    await withState(self.id, state, async () => {
      assert.deepEqual(await duplicatesOf(adminCookie, self.id), [], `a NF com "${name}" mostra o alerta dela mesma`);
    });
  }

  assert.equal((await duplicatesOf(adminCookie, self.id)).length, 1);
  assert.equal((await duplicatesOf(adminCookie, other.id)).length, 1);
});

sessionTest('nova versão não acusa a anterior, e continua acusando uma terceira NF', async () => {
  const key = makeKey();
  const original = await sentNf('user', await danfe(key, 'A', 'versao-1'), 'versao-1');
  const third = await sentNf('sender', await danfe(key, 'B', 'versao-3'), 'versao-3');

  assert.equal((await duplicatesOf(adminCookie, original.id)).length, 1, 'controle: as duas notas se acusam');
  assert.equal((await duplicatesOf(adminCookie, third.id)).length, 1);

  const changed = await trpcAs(adminCookie, 'mutation', 'revalle.finance.changeAccount', {
    envelopeId: original.id,
    code: '3.1.01',
    reason: REASON,
  });

  assert.equal(changed.status, 200, changed.text);

  const v2 = data(changed)?.newEnvelopeId;

  assert.ok(v2, changed.text);
  assert.equal(db(`select status from "Envelope" where id = '${v2}'`), 'PENDING', 'a nova versão não foi enviada');
  assert.equal(accessKeysOf(v2), `{${key}}`, 'a nova versão não copiou as chaves');

  // A antiga está substituída: não mostra o alerta dela, e a terceira acusa só a nova versão (uma nota, não duas).
  assert.deepEqual(await duplicatesOf(adminCookie, original.id), []);
  assert.equal((await duplicatesOf(adminCookie, v2)).length, 1, 'a nova versão acusou a anterior ou perdeu a terceira');
  assert.equal((await duplicatesOf(adminCookie, third.id)).length, 1, 'a terceira acusa a antiga e a nova');

  const thirdPage = await html(adminCookie, `/notas-fiscais/${third.id}`);
  const links = hrefsOf(thirdPage.text, 'invoice-view-duplicate-link');

  assert.deepEqual(links, [`/notas-fiscais/${v2}`], 'a terceira deveria apontar só para a nova versão');

  const v2Page = await html(adminCookie, `/notas-fiscais/${v2}`);

  assert.deepEqual(hrefsOf(v2Page.text, 'invoice-view-duplicate-link'), [`/notas-fiscais/${third.id}`]);
});

aiTest('NF escaneada: a chave que a IA leu soma-se às do texto e acusa; a inválida é ignorada', async () => {
  const key = makeKey();

  await sentNf('sender', await danfe(key, 'A', 'ia-1'), 'ia-1');

  const bytes = await scanned('ia-2');

  await program({ invoiceData: { supplierName: 'Fornecedor Falso LTDA', invoiceNumber: '12345', accessKey: key } });

  const first = await newDraft('user', bytes, 'ia-2');

  assert.equal((await getState(first.owner.cookie, first.id)).isInvoice, 'UNKNOWN');
  assert.equal(accessKeysOf(first.id), '{}');
  assert.deepEqual(await duplicatesOf(first.owner.cookie, first.id), []);

  const flagged = await invoice(first.owner.cookie, 'mutation', 'setInvoiceFlag', {
    envelopeId: first.id,
    isInvoice: true,
  });

  assert.equal(flagged.status, 200, flagged.text);

  const settled = await waitSettled(first.owner.cookie, first.id);

  assert.equal(settled.suggestionStatus, 'DONE', JSON.stringify(settled));
  assert.equal(accessKeysOf(first.id), `{${key}}`, 'a chave lida pela IA não foi guardada');
  assert.equal(settled.duplicates.length, 1, JSON.stringify(settled.duplicates));

  // O mesmo arquivo escaneado em outro documento: a sugestão vem do cache (sem chamar a IA) e a chave vem junto.
  const before = (await calls()).length;
  const copy = await newDraft('user', bytes, 'ia-3');

  await invoice(copy.owner.cookie, 'mutation', 'setInvoiceFlag', { envelopeId: copy.id, isInvoice: true });

  const copyState = await waitSettled(copy.owner.cookie, copy.id);

  assert.equal(copyState.suggestionStatus, 'DONE');
  assert.equal((await calls()).length, before, 'a cópia chamou a IA');
  assert.equal(accessKeysOf(copy.id), `{${key}}`, 'a chave do cache não entrou nas chaves da cópia');
  assert.equal(copyState.duplicates.length, 1);

  // Chave inválida lida pela IA: ignorada, e o aviso não aparece.
  await program({ invoiceData: { supplierName: 'Fornecedor Falso LTDA', accessKey: wrongDigit(key) } });

  const bad = await newDraft('user', await scanned('ia-4'), 'ia-4');

  await invoice(bad.owner.cookie, 'mutation', 'setInvoiceFlag', { envelopeId: bad.id, isInvoice: true });

  const badState = await waitSettled(bad.owner.cookie, bad.id);

  assert.equal(badState.suggestionStatus, 'DONE');
  assert.equal(accessKeysOf(bad.id), '{}', 'uma chave inválida lida pela IA foi guardada');
  assert.deepEqual(badState.duplicates, []);
});

sessionTest('o envio pela API com duplicada não é bloqueado', async () => {
  const key = makeKey();

  await sentNf('sender', await danfe(key, 'A', 'api-1'), 'api-1');

  const second = await draftNf('user', await danfe(key, 'B', 'api-2'), 'api-2');

  assert.equal((await duplicatesOf(second.owner.cookie, second.id)).length, 1);

  await sendNf(second);

  // Depois do envio, o dono continua vendo o aviso (cartão da conta) e a outra nota, o dele.
  assert.equal((await duplicatesOf(second.owner.cookie, second.id)).length, 1);
});

sessionTest(
  'lista e planilha: Financeiro e Contabilidade veem a marca nas duas notas; o colaborador comum, não',
  async () => {
    const key = makeKey();
    const finance = await sentNf('sender', await danfe(key, 'A', 'lista-1'), 'lista-1');
    const mine = await sentNf('user', await danfe(key, 'B', 'lista-2'), 'lista-2', { recipient: signer.email });
    const alone = await sentNf('user', await danfe(makeKey(), 'A', 'lista-sozinha'), 'lista-sozinha');

    fx.list = { key, finance, mine, alone };

    for (const [who, cookie] of [
      ['Financeiro', adminCookie],
      ['Contabilidade', accountant.cookie],
    ]) {
      for (const doc of [finance, mine]) {
        const row = await findRow(cookie, doc.id);

        assert.ok(row, `${who} não vê a NF ${doc.label} na lista`);
        assert.equal(row.isPossibleDuplicate, true, `${who}: ${doc.label} sem a marca`);
      }

      assert.equal((await findRow(cookie, alone.id))?.isPossibleDuplicate, false, `${who}: NF sem par com a marca`);
    }

    // O admin que não é do Financeiro nem da Contabilidade também vê a marca (o rsadmin perde o perfil por instantes).
    const adminId = Number(db(`select id from "User" where email = '${admin.email}'`));

    db(`delete from "RevalleFinanceMember" where "userId" = ${adminId}`);

    try {
      assert.equal(
        (await findRow(adminCookie, mine.id))?.isPossibleDuplicate,
        true,
        'o admin sem perfil não vê a marca',
      );
      assert.deepEqual((await csvRow(adminCookie, mine.id)).cells?.slice(-2), [key, 'sim']);
    } finally {
      const restored = await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', {
        userId: adminId,
        member: true,
      });

      assert.equal(restored.status, 200, restored.text);
    }

    // O colaborador comum não recebe a marca (a consulta nem roda para ele): a NF dele é duplicada e vem `false`.
    const own = await findRow(userCookie, mine.id);

    assert.ok(own, 'o dono não vê a própria NF');
    assert.equal(own.isPossibleDuplicate, false);
    assert.ok(!JSON.stringify(own).includes(finance.id), 'a linha do colaborador aponta para a outra nota');

    // Planilha: a chave e a marca por último; o Financeiro vê "sim", o colaborador comum, vazio (com a própria chave).
    const asFinance = await csvRow(adminCookie, mine.id);

    assert.deepEqual(asFinance.header.slice(-2), ['chave_acesso', 'possivel_duplicada']);
    assert.deepEqual(asFinance.cells?.slice(-2), [key, 'sim']);
    assert.deepEqual((await csvRow(adminCookie, finance.id)).cells?.slice(-2), [key, 'sim']);
    assert.deepEqual((await csvRow(accountant.cookie, mine.id)).cells?.slice(-2), [key, 'sim']);
    assert.deepEqual((await csvRow(userCookie, mine.id)).cells?.slice(-2), [key, '']);
    assert.deepEqual((await csvRow(adminCookie, alone.id)).cells?.slice(-2), [
      `${accessKeysOf(alone.id).slice(1, -1)}`,
      '',
    ]);
  },
);

sessionTest(
  'página da NF: o Financeiro vê título, data, remetente e link; o dono, sem título nem link; quem assina, nada',
  async () => {
    const { finance, mine } = fx.list;

    const asFinance = flat((await html(adminCookie, `/notas-fiscais/${mine.id}`)).text);

    assert.ok(asFinance.includes('data-testid="invoice-view-duplicates"'), 'a página do Financeiro sem o alerta');
    assert.ok(asFinance.includes('Esta nota parece já ter sido enviada'));
    assert.ok(asFinance.includes(finance.title), 'o Financeiro não vê o título da outra nota');
    assert.ok(asFinance.includes(`href="/notas-fiscais/${finance.id}"`), 'o Financeiro não tem o link da outra nota');
    assert.ok(asFinance.includes(`por ${senderLabel(admin.email)} · Pendente`), 'sem o remetente e a situação');
    assert.match(asFinance, /Enviada em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} por /);

    const asOwner = flat((await html(userCookie, `/notas-fiscais/${mine.id}`)).text);

    assert.ok(asOwner.includes('data-testid="invoice-view-duplicates"'), 'o dono não vê o alerta na página da NF');
    assert.ok(asOwner.includes(`por ${senderLabel(admin.email)} · Pendente`));
    assert.ok(!asOwner.includes(finance.title), 'o dono vê o título da outra nota');
    assert.ok(!asOwner.includes(finance.id), 'o dono tem o id da outra nota');
    assert.deepEqual(hrefsOf(asOwner, 'invoice-view-duplicate-link'), []);

    // Quem só assina (é destinatário) abre a página, mas sem o alerta.
    const asSigner = await html(signer.cookie, `/notas-fiscais/${mine.id}`);

    assert.equal(asSigner.status, 200);
    assert.ok(flat(asSigner.text).includes(mine.title), 'controle: o destinatário deveria abrir a página');
    assert.ok(!asSigner.text.includes('invoice-view-duplicates'), 'quem só assina vê o alerta');
    assert.ok(!asSigner.text.includes(finance.id));
  },
);

sessionTest('o alerta some quando a outra NF é recusada (estado, lista, planilha e página)', async () => {
  const { finance, mine } = fx.list;

  await withState(finance.id, STATES['documento recusado'], async () => {
    assert.deepEqual(await duplicatesOf(userCookie, mine.id), []);
    assert.equal((await findRow(adminCookie, mine.id))?.isPossibleDuplicate, false, 'a marca ficou na lista');
    assert.equal((await findRow(accountant.cookie, mine.id))?.isPossibleDuplicate, false);
    assert.equal((await csvRow(adminCookie, mine.id)).cells?.at(-1), '', 'a planilha ainda diz "sim"');
    assert.ok(!(await html(adminCookie, `/notas-fiscais/${mine.id}`)).text.includes('invoice-view-duplicates'));
  });

  assert.equal((await findRow(adminCookie, mine.id))?.isPossibleDuplicate, true, 'viva de novo, a marca volta');
});

sessionTest('o rascunho de uma nova versão tem a marca na lista, como na página', async () => {
  const key = makeKey();
  const third = await sentNf('sender', await danfe(key, 'A', 'rascunho-versao-3'), 'rascunho-versao-3');
  const original = await sentNf('user', await danfe(key, 'B', 'rascunho-versao-1'), 'rascunho-versao-1');

  // A nova versão cujo envio falhou fica em rascunho para o Financeiro; o destinatário de fora da empresa faz o envio falhar.
  db(`update "Recipient" set email = 'fora-${RUN}@example.com' where "envelopeId" = '${original.id}'`);

  const changed = await trpcAs(adminCookie, 'mutation', 'revalle.finance.changeAccount', {
    envelopeId: original.id,
    code: '3.1.01',
    reason: REASON,
  });

  // Com o envio da nova versão falhando, a rota responde com um erro de sucesso parcial e a nova versão fica em rascunho.
  const v2 = db(
    `select "envelopeId" from "RevalleInvoiceClassification" where "previousEnvelopeId" = '${original.id}' limit 1`,
  );

  assert.ok(v2, `a nova versão não foi criada: ${changed.text}`);
  assert.equal(
    db(`select status from "Envelope" where id = '${v2}'`),
    'DRAFT',
    'a nova versão deveria ficar em rascunho',
  );

  assert.equal((await findRow(adminCookie, v2))?.isPossibleDuplicate, true, 'o rascunho da nova versão sem a marca');
  assert.equal((await duplicatesOf(adminCookie, v2)).length, 1);
  assert.equal((await findRow(adminCookie, original.id))?.isPossibleDuplicate, false, 'a substituída tem a marca');
  assert.equal((await findRow(adminCookie, third.id))?.isPossibleDuplicate, false, 'um rascunho de versão acusou');
});

sessionTest(
  'nota que cita a chave de outra (devolução, CT-e) não acusa e não é acusada: só a chave própria vale',
  async () => {
    const original = makeKey();
    const returnKey = makeKey();
    const cteKey = makeKey('57');
    const first = await sentNf('sender', await danfe(original, 'A', 'cita-original'), 'cita-original');
    const returned = await sentNf('user', await devolucao(returnKey, original, 'cita-devolucao'), 'cita-devolucao');
    const transport = await sentNf('user', await dacte(cteKey, original, 'cita-cte'), 'cita-cte');

    // Só a chave própria (a primeira da página) é guardada; a da nota citada fica de fora.
    assert.equal(accessKeysOf(returned.id), `{${returnKey}}`, 'a devolução guardou a chave da nota que ela cita');
    assert.equal(accessKeysOf(transport.id), `{${cteKey}}`, 'o CT-e guardou a chave da NF-e que ele cita');

    const docs = [first, returned, transport];

    for (const doc of docs) {
      assert.deepEqual(await duplicatesOf(adminCookie, doc.id), [], `${doc.label} acusa por uma chave citada`);
      assert.equal(
        (await findRow(adminCookie, doc.id))?.isPossibleDuplicate,
        false,
        `${doc.label} com a marca na lista`,
      );
      assert.equal((await csvRow(adminCookie, doc.id)).cells?.at(-1), '', `${doc.label} com "sim" na planilha`);
    }

    // Controle: uma cópia de verdade da nota original (a mesma chave própria) continua acusando as duas, e só elas.
    const copy = await sentNf('user', await danfe(original, 'B', 'cita-copia'), 'cita-copia');

    assert.equal((await duplicatesOf(adminCookie, first.id)).length, 1, 'a cópia não acusou a original');
    assert.equal((await duplicatesOf(adminCookie, copy.id)).length, 1);
    assert.equal((await findRow(adminCookie, first.id))?.isPossibleDuplicate, true);
    assert.equal((await findRow(adminCookie, copy.id))?.isPossibleDuplicate, true);
    assert.equal((await csvRow(adminCookie, copy.id)).cells?.at(-1), 'sim');

    for (const doc of [returned, transport]) {
      assert.deepEqual(await duplicatesOf(adminCookie, doc.id), [], `${doc.label} passou a acusar depois da cópia`);
      assert.equal((await findRow(adminCookie, doc.id))?.isPossibleDuplicate, false);
    }
  },
);

sessionTest('fileSha256 nulo nunca casa: duas NFs sem chave e sem hash não se acusam (uma NF e o lote)', async () => {
  const bytes = await nfse('hash-nulo');
  const first = await sentNf('sender', bytes, 'nulo-1');
  const second = await sentNf('user', bytes, 'nulo-2');

  assert.equal(accessKeysOf(first.id), '{}');
  assert.equal(accessKeysOf(second.id), '{}');

  // Controle: com o mesmo hash, a NF e o lote acusam.
  assert.equal((await duplicatesOf(adminCookie, second.id)).length, 1, 'controle: o mesmo arquivo deveria acusar');
  assert.equal((await findRow(adminCookie, first.id))?.isPossibleDuplicate, true);
  assert.equal((await findRow(adminCookie, second.id))?.isPossibleDuplicate, true);

  db(
    `update "RevalleInvoiceClassification" set "fileSha256" = null where "envelopeId" in ('${first.id}', '${second.id}')`,
  );
  assert.equal(columnOf(first.id, '"fileSha256" is null'), 't');
  assert.equal(columnOf(second.id, '"fileSha256" is null'), 't');

  // Uma NF: nada a procurar, nada acusa.
  assert.deepEqual(await duplicatesOf(adminCookie, first.id), [], 'o hash nulo casou (uma NF)');
  assert.deepEqual(await duplicatesOf(adminCookie, second.id), [], 'o hash nulo casou (uma NF)');
  // Lote (lista e planilha).
  for (const doc of [first, second]) {
    assert.equal((await findRow(adminCookie, doc.id))?.isPossibleDuplicate, false, 'o hash nulo casou (lote)');
    assert.equal((await csvRow(adminCookie, doc.id)).cells?.at(-1), '');
  }
});

aiTest('trocar o arquivo substitui as chaves: as do texto e a que a IA leu saem junto', async () => {
  const firstKey = makeKey();
  const secondKey = makeKey();
  const aiKey = makeKey();
  const itemOf = (envelope, prefix) => envelope.envelopeItems.find((item) => item.title.startsWith(prefix));
  const removeItem = async (envelope, prefix) => {
    const removed = await api('POST', '/envelope/item/delete', {
      envelopeId: envelope.id,
      envelopeItemId: itemOf(envelope, prefix).id,
    });

    assert.equal(removed.status, 200, removed.text);
  };

  // DANFE + escaneado: a chave do texto e a da IA (a IA só lê o que é NF).
  await program({ invoiceData: { supplierName: 'Fornecedor Falso LTDA', accessKey: aiKey } });

  const mixed = await newEnvelopeWithFiles(
    [
      ['trocar-danfe.pdf', await danfe(firstKey, 'A', 'troca-1')],
      ['trocar-escaneado.pdf', await scanned('troca-1')],
    ],
    'troca-1',
  );

  assert.equal((await invoice(userCookie, 'mutation', 'classify', { envelopeId: mixed.id })).status, 200);
  assert.equal((await waitSettled(userCookie, mixed.id)).suggestionStatus, 'DONE');
  assert.equal(accessKeysOf(mixed.id), `{${firstKey},${aiKey}}`);

  await removeItem(mixed, 'trocar-danfe');

  const after = data(await invoice(userCookie, 'mutation', 'classify', { envelopeId: mixed.id }));

  assert.equal(after.isInvoice, 'UNKNOWN');
  assert.equal(accessKeysOf(mixed.id), '{}', 'as chaves do arquivo anterior ficaram');

  // Dois DANFEs: sai a chave do arquivo removido e fica a do outro.
  await program({});

  const both = await newEnvelopeWithFiles(
    [
      ['trocar-a.pdf', await danfe(firstKey, 'A', 'troca-2a')],
      ['trocar-b.pdf', await danfe(secondKey, 'A', 'troca-2b')],
    ],
    'troca-2',
  );

  assert.equal((await invoice(userCookie, 'mutation', 'classify', { envelopeId: both.id })).status, 200);
  assert.equal(accessKeysOf(both.id), `{${firstKey},${secondKey}}`);

  await removeItem(both, 'trocar-b');
  assert.equal(data(await invoice(userCookie, 'mutation', 'classify', { envelopeId: both.id })).isInvoice, 'YES');
  assert.equal(accessKeysOf(both.id), `{${firstKey}}`, 'a chave do arquivo removido ficou');
});

sessionTest('se a busca de duplicadas falhar, o estado sai sem aviso e o log não traz dados', async () => {
  const key = makeKey();
  const other = await sentNf('sender', await danfe(key, 'A', 'falha-1'), 'falha-1');
  const mine = await draftNf('user', await danfe(key, 'B', 'falha-2'), 'falha-2');

  assert.equal((await duplicatesOf(mine.owner.cookie, mine.id)).length, 1, 'controle: a busca deveria achar a outra');

  // A busca lê o primeiro envio de cada nota no log de auditoria; sem essa tabela só ela falha (o resto do estado não a usa).
  const logsBefore = appLogs().length;

  db(`alter table "DocumentAuditLog" rename to "DocumentAuditLog_f8"`);

  let res;

  try {
    res = await invoice(mine.owner.cookie, 'query', 'get', { envelopeId: mine.id });
  } finally {
    db(`alter table "DocumentAuditLog_f8" rename to "DocumentAuditLog"`);
  }

  assert.equal(res.status, 200, res.text);
  assert.equal(data(res).isInvoice, 'YES');
  assert.deepEqual(data(res).duplicates, [], 'o estado deveria sair sem o aviso');

  const logged = appLogs().slice(logsBefore);

  assert.ok(logged.includes('revalle.invoice.duplicates.failed'), 'a falha da busca não foi registrada');

  // Sem dados no log: nem a chave, nem o hash, nem o remetente, nem o título ou o id da outra nota.
  for (const secret of [
    key,
    columnOf(mine.id, '"fileSha256"'),
    senderLabel(admin.email),
    other.title,
    other.id,
    mine.title,
  ]) {
    assert.ok(!logged.includes(secret), 'o log da falha traz dados da nota');
  }

  assert.equal((await duplicatesOf(mine.owner.cookie, mine.id)).length, 1, 'a busca deveria voltar com a tabela');
});

sessionTest(
  'navegador: o alerta no envio trava o Enviar até a confirmação; o dono vê o aviso sem confirmação depois',
  async (t) => {
    if (!hasPlaywrightImage()) {
      t.skip(`imagem ${PLAYWRIGHT_IMAGE} ausente no Docker (docker pull ${PLAYWRIGHT_IMAGE})`);

      return;
    }

    if (SHOT_DIR) {
      mkdirSync(SHOT_DIR, { recursive: true });
    }

    const key = makeKey();
    const other = await sentNf('sender', await danfe(key, 'A', 'tela-1'), 'tela-1');
    const draft = await draftNf('user', await danfe(key, 'B', 'tela-2'), 'tela-2');
    const chosen = await chooseInvoice({ cookie: userCookie, envelopeId: draft.id });

    assert.equal(chosen.status, 200, chosen.text);

    // Um par já enviado: a NF do dono repete a de outra pessoa (cartão, lista e página da NF). Antes de programar a IA: a
    // chave que ela devolver (a do rascunho escaneado abaixo) entraria nestas notas também.
    const pairKey = makeKey();
    const pair = await sentNf('sender', await danfe(pairKey, 'A', 'tela-par-1'), 'tela-par-1');
    const sent = await sentNf('user', await danfe(pairKey, 'B', 'tela-par-2'), 'tela-par-2');

    // NF escaneada: a chave só chega com a resposta da IA, devagar, com o diálogo já aberto.
    let late;

    if (aiMode === 'fake') {
      await program({
        responseDelayMs: 10_000,
        invoiceData: { supplierName: 'Fornecedor Falso LTDA', accessKey: key },
      });
      late = await newDraft('user', await scanned('tela-3'), 'tela-3');
    }

    const browser = await runBrowserScript({
      script: 'invoice-duplicates.browser.mjs',
      payload: {
        baseUrl: BASE_URL,
        teamUrl,
        ownerCookie: userCookie,
        financeCookie: adminCookie,
        draftId: draft.id,
        lateId: late?.id ?? null,
        otherTitle: other.title,
        otherId: other.id,
        sentId: sent.id,
        sentTitle: sent.title,
        pairId: pair.id,
        pairTitle: pair.title,
        senderName: senderLabel(admin.email),
      },
      shotDir: SHOT_DIR,
      timeout: 300_000,
    });

    t.diagnostic(browser.stdout);
    assert.equal(browser.status, 0, `${browser.stdout}\n${browser.stderr}`);
  },
);
