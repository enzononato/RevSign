// Fase 9, Task 4: lista, planilha, filas, contadores e duplicada POR NOTA num envio com várias notas fiscais.
//   - `revalle.invoice.find`: uma linha por nota (mesmo `id` do envio, `envelopeItemId` de cada nota, `position`,
//     `documentTitle`, conta e centro da nota); `count` conta notas; o filtro de conta é pela conta da nota;
//   - planilha: uma linha por nota, `titulo` com "· nota 2 de 3", cabeçalho igual ao da Fase 8;
//   - contadores do menu (`pendingCounts`) e a fila `financeiro=pendentes` sobem por nota;
//   - duplicada por nota: só a nota repetida de outro envio tem o aviso, a marca da lista e o "sim" da planilha;
//   - a mesma nota duas vezes no mesmo envio (Review Focus 2): `duplicateInEnvelope { index: 1 }` na segunda, sem marcar
//     como duplicada de outro envio;
//   - etiquetas da lista de Documentos (`documentTags`): `invoiceCount`, e conta e centro nulos com 2+ notas.
//
// A IA não é usada na escolha (conta e centro à mão). Só o caso do valor na planilha precisa do servidor FALSO do Gemini
// (scripts/revalle/tests/fake-gemini.mjs, subido com revalle/deploy/compose.test.yml; marcas `FAKEGEMINI:valor=...` no
// texto de cada DANFE); sem ele, é pulado. Nenhuma chamada ao Gemini de verdade.
//
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN, cria, escolhe e envia) e REVSIGN_ADMIN_* (rsadmin: admin e
// Financeiro, importa a lista de contas). Uma conta de teste nova da Contabilidade (criada no banco, ver
// account-helpers.mjs), desmarcada no fim. Este teste SUBSTITUI a lista de contas da stack local (2.1.03, 3.1.01 e uma
// conta só desta execução, para isolar a paginação) e apaga os limites `RateLimit`. Como as outras suítes, deixa os envios
// `[TESTE NF]` no banco e o rsadmin marcado como Financeiro. Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { sessionFor } from './account-helpers.mjs';
import {
  api,
  appContainerEnv,
  assertNoPaidGeminiCalls,
  BASE_URL,
  db,
  fetchIdempotent,
  invoicePdfFile,
  retryCreateOnStaleSocket,
  signIn,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const FAKE_URL = (process.env.REVSIGN_FAKE_GEMINI_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// Conta só desta execução: o filtro por ela traz só as notas do envio da paginação.
const RUN_ACCOUNT = `9.9.${RUN}`;
const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
  `${RUN_ACCOUNT};Conta do teste de paginação;Só para o teste da lista por nota;pagar`,
].join('\n');

// O cabeçalho da planilha da Fase 8, byte a byte (o mesmo de acceptance-f6 e export-csv.test.ts).
const HEADER =
  'id;titulo;remetente;enviado_em;concluido_em;status;conta;nome_conta;tipo;sugestao_ia;confianca;aceitou_sugestao;link;financeiro;aprovado_por;centro_custo;nome_centro_custo;validacao_contabilidade;validado_por;fornecedor;numero_nf;valor;chave_acesso;possivel_duplicada';

// As três notas do envio: arquivo, conta, centro e o valor que a IA falsa lê.
const NOTES = [
  { title: 'nf-a.pdf', code: '2.1.03', center: '101', valor: '100.00' },
  { title: 'nf-b.pdf', code: '3.1.01', center: '201', valor: '200.00' },
  { title: 'nf-c.pdf', code: '2.1.03', center: '301', valor: '300.00' },
];

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-lista-varias-notas-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userCookie;
let adminCookie;
let aiMode = 'off';
const fx = {};

const data = (res) => res.body?.result?.data?.json;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia' }).format(new Date());

const getState = async (envelopeId, cookie = userCookie) => {
  const res = await trpcAs(cookie, 'query', 'revalle.invoice.get', { envelopeId });

  assert.equal(res.status, 200, res.text);

  return data(res);
};

const isReading = (state) =>
  state.suggestionStatus === 'PENDING' || state.documents.some((doc) => doc.suggestionStatus === 'PENDING');

// Com a IA falsa no ar, espera a leitura de todas as notas terminar (o valor entra com ela).
const waitSettled = async (envelopeId, timeoutMs = 40_000) => {
  const deadline = performance.now() + timeoutMs;
  let state = await getState(envelopeId);

  while (isReading(state) && performance.now() < deadline) {
    await sleep(400);
    state = await getState(envelopeId);
  }

  assert.ok(!isReading(state), 'a leitura da IA não terminou');

  return state;
};

const docOf = (state, title) => {
  const doc = state.documents.find((candidate) => candidate.title === title);

  assert.ok(doc, `${title} não está em documents: ${state.documents.map((candidate) => candidate.title)}`);

  return doc;
};

const pendingCounts = async (cookie) => {
  const res = await trpcAs(cookie, 'query', 'revalle.invoice.pendingCounts');

  assert.equal(res.status, 200, res.text);

  return data(res);
};

const find = async (cookie, filters = {}, page = 1) => {
  const res = await trpcAs(cookie, 'query', 'revalle.invoice.find', { perPage: 100, page, ...filters });

  assert.equal(res.status, 200, res.text);

  return data(res);
};

// As linhas de um envio na lista (todas as páginas de hoje), na ordem da lista.
const rowsOf = async (cookie, envelopeId, filters = {}) => {
  const rows = [];

  for (let page = 1; page <= 50; page += 1) {
    const body = await find(cookie, { from: today(), ...filters }, page);

    rows.push(...body.data.filter((row) => row.id === envelopeId));

    if (page >= body.totalPages) {
      break;
    }
  }

  return rows;
};

// Planilha de hoje: o cabeçalho e as linhas de um envio (célula por nome de coluna), na ordem da planilha.
const csvRowsOf = async (cookie, envelopeId) => {
  const res = await fetchIdempotent(
    `${BASE_URL}/notas-fiscais/csv?de=${today()}`,
    { headers: { Cookie: cookie } },
    async (r) => ({
      status: r.status,
      text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer()),
    }),
  );

  assert.equal(res.status, 200, res.text.slice(0, 300));
  assert.ok(res.text.startsWith('﻿'), 'planilha sem BOM');

  const [header, ...lines] = res.text.slice(1).split('\r\n').filter(Boolean);
  const names = HEADER.split(';');

  return {
    header,
    rows: lines
      .filter((line) => line.startsWith(`${envelopeId};`))
      .map((line) => Object.fromEntries(line.split(';').map((cell, index) => [names[index], cell]))),
  };
};

// ---------- Envio ----------

const loadItems = (envelopeId) =>
  Object.fromEntries(
    db(`select title || '|' || id from "EnvelopeItem" where "envelopeId" = '${envelopeId}' order by "order"`)
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('|')),
  );

// Um DANFE novo (chave e arquivo novos) com o valor que a IA falsa lê.
const danfe = (title, valor, label) =>
  invoicePdfFile({ variant: title.replace('.pdf', ''), markers: { valor }, extraLines: [`${label} ${RUN}`] });

// A cópia exata de um arquivo, com outro nome (mesmo SHA-256 e mesma chave).
const copyAs = (file, title) => {
  const dir = mkdtempSync(path.join(tmp, 'copia-'));
  const target = path.join(dir, title);

  copyFileSync(file, target);

  return target;
};

// Rascunho (API v2) com os arquivos dados, um campo de assinatura do signatário em cada arquivo (o envio exige) e
// classificado. Devolve o id e os arquivos (título → id do item).
const newDraft = async (label, files) => {
  const title = `[TESTE NF] lista várias notas ${label} ${RUN}`;
  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title,
      type: 'DOCUMENT',
      meta: { distributionMethod: 'NONE' },
      recipients: [
        {
          role: 'SIGNER',
          name: 'Teste',
          email: `f9-lista-${label}-${RUN}@revalle.com.br`,
          fields: files.map((_, identifier) => ({
            type: 'SIGNATURE',
            identifier,
            page: 1,
            positionX: 10,
            positionY: 80,
            width: 30,
            height: 8,
          })),
        },
      ],
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

  const id = created.body.id;
  const classified = await trpcAs(userCookie, 'mutation', 'revalle.invoice.classify', { envelopeId: id });

  assert.equal(classified.status, 200, classified.text);
  assert.deepEqual(
    data(classified).documents.map((doc) => doc.kind),
    files.map(() => 'NF'),
  );

  return { id, title, items: loadItems(id) };
};

// Conta e centro à mão em cada nota (`notes`: título → { code, center }).
const chooseAll = async (draft, notes) => {
  for (const note of notes) {
    const envelopeItemId = draft.items[note.title];

    for (const res of [
      await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
        envelopeId: draft.id,
        envelopeItemId,
        choice: { code: note.code },
      }),
      await trpcAs(userCookie, 'mutation', 'revalle.invoice.setCostCenter', {
        envelopeId: draft.id,
        envelopeItemId,
        code: note.center,
      }),
    ]) {
      assert.equal(res.status, 200, res.text);
    }
  }
};

const send = async (draft) => {
  const sent = await api('POST', '/envelope/distribute', { envelopeId: draft.id });

  assert.equal(sent.status, 200, sent.text);
  assert.equal(
    db(`select "financeStatus" from "RevalleInvoiceClassification" where "envelopeId" = '${draft.id}'`),
    'PENDING_APPROVAL',
  );

  return draft;
};

// O envio de três notas (contas 2.1.03, 3.1.01, 2.1.03; centros 101, 201, 301), escolhido e enviado.
const newSentThree = async (label, notes = NOTES) => {
  const draft = await newDraft(
    label,
    notes.map((note) => danfe(note.title, note.valor, label)),
  );

  if (aiMode === 'fake') {
    await waitSettled(draft.id);
  }

  await chooseAll(draft, notes);

  return await send(draft);
};

// ---------- Casos ----------

const sessionTest = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie || !adminCookie) {
      t.skip('credenciais de sessão (REVSIGN_USER_*, REVSIGN_ADMIN_*) não informadas');

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
  const userId = Number(db(`select id from "User" where email = '${user.email}'`));
  const marked = await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', {
    userId: adminId,
    member: true,
  });

  assert.equal(marked.status, 200, marked.text);
  // O dono não é do Financeiro nem da Contabilidade (o contador dele é `null`).
  db(`delete from "RevalleFinanceMember" where "userId" = ${userId}`);
  db(`delete from "RevalleAccountingMember" where "userId" = ${userId}`);

  const email = `f9-lista-contabilidade-${RUN}@revalle.com.br`;
  const cookie = await sessionFor(email);

  fx.accountant = { email, cookie, id: Number(db(`select id from "User" where email = '${email}'`)) };

  const accounting = await trpcAs(adminCookie, 'mutation', 'revalle.accounting.adminSetMember', {
    userId: fx.accountant.id,
    isMember: true,
  });

  assert.equal(accounting.status, 200, accounting.text);

  const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });

  assert.equal(imported.status, 200, imported.text);
  db('delete from "RateLimit"');

  const hasKey = appContainerEnv('GEMINI_API_KEY').trim() !== '';
  const disabled = appContainerEnv('NEXT_PRIVATE_REVALLE_INVOICE_AI').trim().toLowerCase() === 'disabled';
  const fakeUp = await fetch(`${FAKE_URL}/__health`)
    .then((res) => res.ok)
    .catch(() => false);

  aiMode = hasKey && !disabled && fakeUp ? 'fake' : 'off';
});

after(async () => {
  if (adminCookie && fx.accountant) {
    await trpcAs(adminCookie, 'mutation', 'revalle.accounting.adminSetMember', {
      userId: fx.accountant.id,
      isMember: false,
    });
  }
});

beforeEach(() => {
  db('delete from "RateLimit"');
});

sessionTest('lista: uma linha por nota, com a posição e o envio', async () => {
  const countBefore = (await find(adminCookie, { from: today() })).count;
  const doc = await newSentThree('lista');

  fx.three = doc;

  const rows = await rowsOf(adminCookie, doc.id);

  assert.equal(rows.length, 3, JSON.stringify(rows.map((row) => row.documentTitle)));
  assert.deepEqual(
    rows.map((row) => row.id),
    [doc.id, doc.id, doc.id],
  );
  assert.equal(new Set(rows.map((row) => row.envelopeItemId)).size, 3, 'envelopeItemId repetido');
  assert.deepEqual(
    rows.map((row) => row.envelopeItemId),
    NOTES.map((note) => doc.items[note.title]),
  );
  assert.deepEqual(
    rows.map((row) => row.position),
    [
      { index: 1, total: 3 },
      { index: 2, total: 3 },
      { index: 3, total: 3 },
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.documentTitle),
    NOTES.map((note) => note.title),
  );
  assert.deepEqual(
    rows.map((row) => row.account?.code),
    NOTES.map((note) => note.code),
  );
  assert.deepEqual(
    rows.map((row) => row.costCenterCode),
    ['101', '201', '301'],
  );
  // O título e o link são do envio.
  assert.deepEqual(
    rows.map((row) => row.title),
    [doc.title, doc.title, doc.title],
  );
  assert.ok(
    rows.every((row) => row.link === `/notas-fiscais/${doc.id}`),
    JSON.stringify(rows.map((r) => r.link)),
  );

  // `count` conta notas: o envio de três notas soma 3 (o rascunho não aparecia na lista antes do envio).
  assert.equal((await find(adminCookie, { from: today() })).count, countBefore + 3);
});

aiTest('planilha: uma linha por nota, título com a posição e cabeçalho igual', async () => {
  const doc = fx.three ?? (await newSentThree('planilha'));
  const { header, rows } = await csvRowsOf(adminCookie, doc.id);

  assert.equal(header, HEADER);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.titulo),
    [1, 2, 3].map((index) => `${doc.title} · nota ${index} de 3`),
  );
  assert.deepEqual(
    rows.map((row) => row.valor),
    ['100,00', '200,00', '300,00'],
  );
  assert.deepEqual(
    rows.map((row) => row.conta),
    NOTES.map((note) => note.code),
  );
  assert.ok(rows.every((row) => row.link.endsWith(`/notas-fiscais/${doc.id}`)));
});

sessionTest('planilha: o envio de uma nota fica com o título de sempre', async () => {
  const single = await newDraft('planilha-uma', [danfe('nf-unica.pdf', '150.00', 'planilha-uma')]);

  await chooseAll(single, [{ title: 'nf-unica.pdf', code: '2.1.03', center: '101' }]);
  await send(single);

  const { header, rows } = await csvRowsOf(adminCookie, single.id);

  assert.equal(header, HEADER);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].titulo, single.title);

  const [row] = await rowsOf(adminCookie, single.id);

  assert.deepEqual(row.position, { index: 1, total: 1 });
  assert.equal(row.documentTitle, 'nf-unica.pdf');
});

sessionTest('filtro de conta é por nota', async () => {
  const doc = fx.three ?? (await newSentThree('conta'));
  const rows = await rowsOf(adminCookie, doc.id, { accountCode: '3.1.01' });

  assert.equal(rows.length, 1, JSON.stringify(rows.map((row) => row.documentTitle)));
  assert.equal(rows[0].documentTitle, 'nf-b.pdf');
  assert.equal(rows[0].envelopeItemId, doc.items['nf-b.pdf']);

  const others = await rowsOf(adminCookie, doc.id, { accountCode: '2.1.03' });

  assert.deepEqual(
    others.map((row) => row.documentTitle),
    ['nf-a.pdf', 'nf-c.pdf'],
  );
});

sessionTest('contadores sobem por nota', async () => {
  const before = {
    finance: (await pendingCounts(adminCookie)).finance,
    accounting: (await pendingCounts(fx.accountant.cookie)).accounting,
  };

  assert.equal(typeof before.finance, 'number');
  assert.equal(typeof before.accounting, 'number');
  assert.deepEqual(await pendingCounts(userCookie), { finance: null, accounting: null });

  await newSentThree('contador');

  assert.equal((await pendingCounts(adminCookie)).finance, before.finance + 3);
  assert.equal((await pendingCounts(fx.accountant.cookie)).accounting, before.accounting + 3);

  const single = await newDraft('contador-uma', [danfe('nf-unica.pdf', '150.00', 'contador-uma')]);

  await chooseAll(single, [{ title: 'nf-unica.pdf', code: '2.1.03', center: '101' }]);
  await send(single);

  const after = await pendingCounts(adminCookie);

  assert.equal(after.finance, before.finance + 4);
  assert.equal((await pendingCounts(fx.accountant.cookie)).accounting, before.accounting + 4);

  // A fila da página traz o mesmo número que o menu (notas, não envios).
  assert.equal((await find(adminCookie, { finance: 'pendentes' })).count, after.finance);
  assert.equal(
    (await find(fx.accountant.cookie, { accounting: 'pendentes' })).count,
    (await pendingCounts(fx.accountant.cookie)).accounting,
  );
});

sessionTest('duplicada por nota', async () => {
  const original = danfe('nf-a.pdf', '100.00', 'duplicada-x');
  const x = await newDraft('duplicada-x', [original]);

  await chooseAll(x, [{ title: 'nf-a.pdf', code: '2.1.03', center: '101' }]);
  await send(x);

  const y = await newDraft('duplicada-y', [copyAs(original, 'nf-a.pdf'), danfe('nf-n.pdf', '50.00', 'duplicada-y')]);
  const draftState = await getState(y.id);

  assert.equal(docOf(draftState, 'nf-a.pdf').duplicates.length, 1, 'a cópia não acusou a nota do outro envio');
  assert.deepEqual(docOf(draftState, 'nf-n.pdf').duplicates, []);
  assert.equal(draftState.duplicates.length, 1, 'o aviso do envio é a união das notas');
  assert.equal(docOf(draftState, 'nf-a.pdf').duplicateInEnvelope, null);

  await chooseAll(y, [
    { title: 'nf-a.pdf', code: '2.1.03', center: '101' },
    { title: 'nf-n.pdf', code: '2.1.03', center: '201' },
  ]);
  await send(y);

  const state = await getState(y.id);

  assert.equal(docOf(state, 'nf-a.pdf').duplicates.length, 1);
  assert.deepEqual(docOf(state, 'nf-n.pdf').duplicates, []);

  // Lista do Financeiro: a marca só na linha da nota repetida.
  const rows = await rowsOf(adminCookie, y.id);

  assert.deepEqual(
    rows.map((row) => [row.documentTitle, row.isPossibleDuplicate]),
    [
      ['nf-a.pdf', true],
      ['nf-n.pdf', false],
    ],
  );

  // Planilha: "sim" só nela.
  const { rows: cells } = await csvRowsOf(adminCookie, y.id);

  assert.deepEqual(
    cells.map((row) => row.possivel_duplicada),
    ['sim', ''],
  );

  // A página da NF: a seção da nota repetida tem o aviso (com o link para a outra nota); a outra seção, não.
  const page = await fetchIdempotent(
    `${BASE_URL}/notas-fiscais/${y.id}`,
    { headers: { Cookie: adminCookie } },
    async (r) => ({ status: r.status, text: await r.text() }),
  );

  assert.equal(page.status, 200);

  const sections = page.text.split('data-testid="invoice-view-note"').slice(1);
  const linksTo = (text) => text.split(`href="/notas-fiscais/${x.id}"`).length - 1;

  assert.equal(sections.length, 2, 'a página não tem uma seção por nota');
  assert.equal(linksTo(sections[0]), 1, 'a seção de nf-a.pdf sem o aviso');
  assert.equal(linksTo(sections[1]), 0, 'a seção de nf-n.pdf com o aviso da outra nota');
});

sessionTest('a mesma nota duas vezes no mesmo envio', async () => {
  const original = danfe('nf-a.pdf', '100.00', 'mesma');
  const draft = await newDraft('mesma', [original, copyAs(original, 'nf-a-copia.pdf')]);
  const state = await getState(draft.id);

  assert.equal(docOf(state, 'nf-a.pdf').duplicateInEnvelope, null);
  assert.deepEqual(docOf(state, 'nf-a-copia.pdf').duplicateInEnvelope, { index: 1 });
  // Não é duplicada de outro envio.
  assert.deepEqual(docOf(state, 'nf-a.pdf').duplicates, []);
  assert.deepEqual(docOf(state, 'nf-a-copia.pdf').duplicates, []);
  assert.deepEqual(state.duplicates, []);

  // Enviado, a lista também não marca nenhuma das duas (a outra nota é do mesmo envio).
  await chooseAll(draft, [
    { title: 'nf-a.pdf', code: '2.1.03', center: '101' },
    { title: 'nf-a-copia.pdf', code: '2.1.03', center: '101' },
  ]);
  await send(draft);

  const rows = await rowsOf(adminCookie, draft.id);

  assert.deepEqual(
    rows.map((row) => row.isPossibleDuplicate),
    [false, false],
  );
});

sessionTest('aprovar 1 de 3: a nota sai das filas do Financeiro e entra em aprovadas', async () => {
  const doc = await newSentThree('aprova-uma');
  const before = (await pendingCounts(adminCookie)).finance;
  const a = doc.items['nf-a.pdf'];
  const approved = await trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', {
    envelopeId: doc.id,
    envelopeItemId: a,
  });

  assert.equal(approved.status, 200, approved.text);
  assert.deepEqual(data(approved), { approved: true });
  assert.equal((await pendingCounts(adminCookie)).finance, before - 1);

  const titles = async (finance) => (await rowsOf(adminCookie, doc.id, { finance })).map((row) => row.documentTitle);

  assert.deepEqual(await titles('aprovadas'), ['nf-a.pdf']);
  assert.deepEqual(await titles('aguardando-aprovacao'), ['nf-b.pdf', 'nf-c.pdf']);
  assert.deepEqual(await titles('pendentes'), ['nf-b.pdf', 'nf-c.pdf']);

  // A linha diz a situação de cada nota.
  assert.deepEqual(
    (await rowsOf(adminCookie, doc.id)).map((row) => row.financeStatus),
    ['APPROVED', 'PENDING_APPROVAL', 'PENDING_APPROVAL'],
  );
});

sessionTest('paginação por nota: sem linha repetida nem faltando, e a contagem certa', async () => {
  const notes = NOTES.map((note) => ({ ...note, code: RUN_ACCOUNT }));
  const doc = await newSentThree('paginas', notes);
  const filters = { from: today(), accountCode: RUN_ACCOUNT, perPage: 2 };
  const first = await find(adminCookie, filters, 1);
  const second = await find(adminCookie, filters, 2);

  assert.equal(first.count, 3);
  assert.equal(second.count, 3);
  assert.equal(first.totalPages, 2);
  assert.equal(first.data.length, 2);
  assert.equal(second.data.length, 1);

  const rows = [...first.data, ...second.data];

  assert.ok(rows.every((row) => row.id === doc.id));
  assert.deepEqual(
    rows.map((row) => row.envelopeItemId),
    NOTES.map((note) => doc.items[note.title]),
    'linha repetida ou faltando entre as páginas',
  );
  assert.deepEqual(
    rows.map((row) => row.position.index),
    [1, 2, 3],
  );
});

sessionTest('o dono vê uma linha por nota, com o link do documento', async () => {
  const doc = fx.three ?? (await newSentThree('dono'));
  const rows = await rowsOf(userCookie, doc.id);
  const teamUrl = db(`select t.url from "Team" t join "Envelope" e on e."teamId" = t.id where e.id = '${doc.id}'`);

  assert.deepEqual(
    rows.map((row) => row.documentTitle),
    NOTES.map((note) => note.title),
  );
  // O link do dono é o do documento no time, o mesmo nas três (a âncora da nota é só da página da NF).
  assert.ok(
    rows.every((row) => row.link === `/t/${teamUrl}/documents/${doc.id}`),
    JSON.stringify(rows.map((row) => row.link)),
  );
  // O dono não decide sobre a nota: nem a marca de duplicada nem a consulta.
  assert.ok(rows.every((row) => row.isPossibleDuplicate === false));
});

sessionTest('etiquetas da lista de Documentos', async () => {
  const doc = fx.three ?? (await newSentThree('etiquetas'));
  const single = await newDraft('etiquetas-uma', [danfe('nf-unica.pdf', '150.00', 'etiquetas-uma')]);

  await chooseAll(single, [{ title: 'nf-unica.pdf', code: '2.1.03', center: '101' }]);

  const teamId = Number(db(`select "teamId" from "Envelope" where id = '${doc.id}'`));
  const res = await trpcAs(userCookie, 'query', 'revalle.invoice.documentTags', {
    teamId,
    envelopeIds: [doc.id, single.id],
  });

  assert.equal(res.status, 200, res.text);

  const tags = new Map(data(res).map((tag) => [tag.envelopeId, tag]));

  assert.deepEqual(tags.get(doc.id), { envelopeId: doc.id, account: null, costCenterCode: null, invoiceCount: 3 });
  assert.deepEqual(tags.get(single.id), {
    envelopeId: single.id,
    account: { code: '2.1.03', name: 'Fornecedores' },
    costCenterCode: '101',
    invoiceCount: 1,
  });
});
