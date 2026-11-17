// Fase 9, Task 5: o diálogo de envio com várias notas (e boleto), no navegador. Um bloco por arquivo: `Nota 2 de 3 ·
// nf-b.pdf` com a conta e o centro dessa nota, `Boleto · boleto.pdf` com o que foi lido e o aviso em âmbar, o contrato numa
// linha "documento comum" e o arquivo sem texto com "Este arquivo é:". O botão Enviar só libera com conta e centro em
// todas as notas e com o tipo de todo arquivo sem texto respondido; o aviso do boleto não trava.
//
// A IA é o servidor FALSO (scripts/revalle/tests/fake-gemini.mjs, subido com revalle/deploy/compose.test.yml): as marcas
// `FAKEGEMINI:campo=valor` no texto de cada DANFE dizem o valor de cada nota (R$ 100, 200 e 300, que não batem com o
// boleto de R$ 1.499,00). Sem o servidor falso, ou sem a imagem do Playwright, os casos são pulados. Nenhuma chamada ao
// Gemini de verdade. Nada é enviado: os rascunhos ficam como rascunho.
//
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN) e REVSIGN_ADMIN_* (importa a lista de contas). Este teste SUBSTITUI a
// lista de contas da stack local (2.1.03 e 3.1.01) e apaga os contadores de limite `revalle.invoice*`. Prints do celular
// em REVSIGN_F9_SHOTS (pasta já criada), quando definido. Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PDFDocument, rgb } from '@cantoo/pdf-lib';

import {
  api,
  appContainerEnv,
  assertNoPaidGeminiCalls,
  BASE_URL,
  boletoPdfFile,
  db,
  hasPlaywrightImage,
  invoicePdfFile,
  makeAccessKey,
  PLAYWRIGHT_IMAGE,
  retryCreateOnStaleSocket,
  runBrowserScript,
  signIn,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const FAKE_URL = (process.env.REVSIGN_FAKE_GEMINI_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };
const SHOT_DIR = process.env.REVSIGN_F9_SHOTS;

const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
].join('\n');

// O emitente das notas (na chave de acesso) e do boleto: só o valor do boleto não bate.
const NF_CNPJ = '12345678000195';
const BOLETO_CENTS = 149900;
const BOLETO_WARNING = 'O valor do boleto (R$ 1.499,00) não bate com nenhuma nota do envio.';

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-varias-notas-ui-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userCookie;
let aiMode = 'off';
let skipReason;

const data = (res) => res.body?.result?.data?.json;
const invoice = (kind, name, input) => trpcAs(userCookie, kind, `revalle.invoice.${name}`, input);

const fake = async (route, body) => {
  const res = await fetch(`${FAKE_URL}${route}`, body ? { method: 'POST', body: JSON.stringify(body) } : {});

  assert.equal(res.status, 200, `fake ${route}: ${res.status}`);

  return res.json();
};

// 'AAAA-MM-DD' em Brasília, `days` dias a partir de hoje.
const brasiliaDay = (days) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Bahia' });

// ---------- Estado ----------

const getState = async (envelopeId) => {
  const res = await invoice('query', 'get', { envelopeId });

  assert.equal(res.status, 200, res.text);

  return data(res);
};
const classify = async (envelopeId) => {
  const res = await invoice('mutation', 'classify', { envelopeId });

  assert.equal(res.status, 200, res.text);

  return data(res);
};
const isReading = (state) =>
  state.suggestionStatus === 'PENDING' || state.documents.some((doc) => doc.suggestionStatus === 'PENDING');
const waitSettled = async (envelopeId, timeoutMs = 40_000) => {
  const deadline = performance.now() + timeoutMs;
  let state = await getState(envelopeId);

  while (isReading(state) && performance.now() < deadline) {
    await sleep(400);
    state = await getState(envelopeId);
  }

  assert.ok(
    !isReading(state),
    `a leitura não terminou: ${JSON.stringify(state.documents.map((d) => d.suggestionStatus))}`,
  );

  return state;
};
const docOf = (state, title) => {
  const doc = state.documents.find((candidate) => candidate.title === title);

  assert.ok(doc, `${title} não está em documents: ${state.documents.map((candidate) => candidate.title)}`);

  return doc;
};

// ---------- Arquivos ----------

const contract = () => {
  const file = path.join(mkdtempSync(path.join(tmp, 'c-')), 'contrato.pdf');

  copyFileSync('assets/example.pdf', file);

  return file;
};

// PDF só com desenho (sem texto): a classificação não sabe dizer o tipo (UNKNOWN).
const scannedFile = async (variant) => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);

  for (let i = 0; i < 12; i += 1) {
    page.drawRectangle({
      x: 40 + i * 30,
      y: 500 + (i % 3) * 40,
      width: 20,
      height: 20,
      color: rgb(0.1 * (i % 9), 0.2, 0.3),
    });
  }

  doc.setTitle(`${variant} ${RUN}`);

  const file = path.join(mkdtempSync(path.join(tmp, 's-')), `${variant}.pdf`);

  writeFileSync(file, Buffer.from(await doc.save()));

  return file;
};

const nf = (variant, valor) =>
  invoicePdfFile({ variant, accessKey: makeAccessKey({ cnpj: NF_CNPJ }), markers: { valor } });

const boleto = () =>
  boletoPdfFile({
    variant: 'boleto',
    amountCents: BOLETO_CENTS,
    dueDate: brasiliaDay(10),
    cnpj: NF_CNPJ,
    markers: { cnpj: NF_CNPJ },
  });

// Envelope (API v2) com vários arquivos e um signatário da empresa com um campo de assinatura em CADA arquivo (v.19: o
// diálogo de envio só mostra o bloco da nota com todas as assinaturas posicionadas).
const newEnvelopeWithFiles = async (files, label) => {
  const apiToken = process.env.REVSIGN_API_TOKEN;
  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title: `[TESTE NF] várias notas tela ${label} ${RUN}`,
      type: 'DOCUMENT',
      meta: { distributionMethod: 'NONE' },
      recipients: [
        {
          role: 'SIGNER',
          name: 'Teste',
          email: `varias-ui-${label}-${RUN}@revalle.com.br`,
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
      headers: { Authorization: `Bearer ${apiToken}` },
      body: form,
    });

    return { status: res.status, body: await res.json() };
  });

  assert.equal(created.status, 200, JSON.stringify(created.body));

  const envelope = (await api('GET', `/envelope/${created.body.id}`)).body;
  const items = Object.fromEntries(envelope.envelopeItems.map((item) => [item.title, item.id]));
  const teamUrl = db(`select url from "Team" where id = ${Number(envelope.teamId)}`);

  return { id: created.body.id, items, teamUrl };
};

// Contrato, três notas e o boleto de R$ 1.499,00, lidos até o fim.
// `extraNotes`: notas a mais depois da nf-c (o celular usa uma com o nome de 44 dígitos de uma NF-e); a soma continua sem
// bater com o boleto.
const newThreeNotesDraft = async (label, extraNotes = []) => {
  const env = await newEnvelopeWithFiles(
    [contract(), nf('nf-a', '100.00'), nf('nf-b', '200.00'), nf('nf-c', '300.00'), ...extraNotes, boleto()],
    label,
  );
  const first = await classify(env.id);

  assert.deepEqual(
    first.documents.map((doc) => doc.kind),
    ['OTHER', 'NF', 'NF', 'NF', ...extraNotes.map(() => 'NF'), 'BOLETO'],
  );

  const state = await waitSettled(env.id);

  assert.deepEqual(
    docOf(state, 'boleto.pdf').boleto.warnings.map((warning) => warning.message),
    [BOLETO_WARNING],
  );

  for (const title of Object.keys(env.items).filter((name) => name !== 'contrato.pdf' && name !== 'boleto.pdf')) {
    assert.equal(docOf(state, title).choice, null, `${title} já tem conta`);
    assert.equal(docOf(state, title).costCenter, null, `${title} já tem centro`);
  }

  return env;
};

const runCase = async (t, payload) => {
  const browser = await runBrowserScript({
    script: 'invoice-multi-ui.browser.mjs',
    payload: { baseUrl: BASE_URL, ownerCookie: userCookie, boletoWarning: BOLETO_WARNING, ...payload },
    shotDir: SHOT_DIR,
    timeout: 240_000,
  });

  t.diagnostic(browser.stdout);
  assert.equal(browser.status, 0, `${browser.stdout}\n${browser.stderr}`);
};

// ---------- Casos ----------

const uiTest = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie) {
      t.skip('credenciais de sessão não informadas');

      return;
    }

    if (aiMode !== 'fake') {
      t.skip(skipReason ?? 'stack sem o servidor falso do Gemini');

      return;
    }

    if (!hasPlaywrightImage()) {
      t.skip(`imagem ${PLAYWRIGHT_IMAGE} ausente no Docker (docker pull ${PLAYWRIGHT_IMAGE})`);

      return;
    }

    await fn(t);
  });

before(async () => {
  if (!user.email || !user.password || !admin.email || !admin.password) {
    return;
  }

  userCookie = await signIn(user.email, user.password);

  const adminCookie = await signIn(admin.email, admin.password);
  const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });

  assert.equal(imported.status, 200, imported.text);
  db(`delete from "RateLimit" where action like 'revalle.invoice%'`);

  const hasKey = appContainerEnv('GEMINI_API_KEY').trim() !== '';
  const disabled = appContainerEnv('NEXT_PRIVATE_REVALLE_INVOICE_AI').trim().toLowerCase() === 'disabled';
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
  if (aiMode === 'fake') {
    await fake('/__reset', {});
  }
});

uiTest('diálogo com uma nota por bloco e o aviso do boleto', async (t) => {
  const env = await newThreeNotesDraft('blocos');

  await runCase(t, { case: 'blocks', teamUrl: env.teamUrl, draftId: env.id, items: env.items });

  // A tela gravou a conta e o centro de cada nota, no arquivo dela.
  const state = await getState(env.id);

  for (const title of ['nf-a.pdf', 'nf-b.pdf', 'nf-c.pdf']) {
    assert.ok(docOf(state, title).choice, `${title} ficou sem conta`);
    assert.ok(docOf(state, title).costCenter, `${title} ficou sem centro`);
  }

  assert.equal(db(`select status from "Envelope" where id = '${env.id}'`), 'DRAFT');
});

uiTest('escaneado pede o tipo antes de enviar', async (t) => {
  const env = await newEnvelopeWithFiles([nf('nf-s', '100.00'), await scannedFile('escaneado')], 'escaneado');
  const first = await classify(env.id);

  assert.deepEqual(
    first.documents.map((doc) => doc.kind),
    ['NF', 'UNKNOWN'],
  );
  await waitSettled(env.id);

  // A nota já tem a conta e o centro: só o tipo do escaneado segura o Enviar.
  for (const [name, input] of [
    ['setChoice', { envelopeId: env.id, choice: { code: '2.1.03' } }],
    ['setCostCenter', { envelopeId: env.id, code: '101' }],
  ]) {
    const res = await invoice('mutation', name, input);

    assert.equal(res.status, 200, res.text);
  }

  await runCase(t, {
    case: 'scanned',
    teamUrl: env.teamUrl,
    draftId: env.id,
    items: env.items,
  });

  assert.equal(docOf(await getState(env.id), 'escaneado.pdf').kind, 'OTHER');
});

uiTest('celular de 390 px', async (t) => {
  // Nome de arquivo como a chave de acesso de uma NF-e: 44 dígitos sem espaço.
  const longName = makeAccessKey({ cnpj: NF_CNPJ });
  const env = await newThreeNotesDraft('celular', [nf(longName, '400.00')]);

  assert.ok(env.items[`${longName}.pdf`], 'a nota de nome longo não entrou no envio');

  await runCase(t, { case: 'phone', teamUrl: env.teamUrl, draftId: env.id, items: env.items });
});
