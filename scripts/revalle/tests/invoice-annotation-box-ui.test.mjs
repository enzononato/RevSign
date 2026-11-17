// v.20: o bloco "Conta e centro de custo" no navegador. No editor (passo "Adicionar campos"): arrastar o bloco da paleta
// para a nota, ver no mesmo lugar depois de recarregar e tirar. No diálogo de envio: a linha "No PDF: …" de cada nota e o
// aviso em âmbar do bloco num arquivo que não é nota (que não trava o Enviar). O bloco não é campo: não entra na
// contagem "cada signatário precisa de assinatura em cada documento".
//
// A IA não é necessária (a nota é reconhecida pelo texto). Com o servidor falso do Gemini na stack, ele responde a
// leitura; com a chave do Gemini de verdade, `assertNoPaidGeminiCalls` para tudo. Sem a imagem do Playwright, os casos são
// pulados. Nada é enviado: os rascunhos ficam como rascunho.
//
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN) e REVSIGN_ADMIN_* (importa a lista de contas). Este teste
// SUBSTITUI a lista de contas da stack local (2.1.03 e 3.1.01) e apaga os contadores de limite `revalle.invoice*`. Prints
// em REVSIGN_F9_SHOTS (pasta já criada), quando definido. Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';

import {
  api,
  assertNoPaidGeminiCalls,
  BASE_URL,
  chooseInvoice,
  db,
  hasPlaywrightImage,
  invoicePdfFile,
  PLAYWRIGHT_IMAGE,
  retryCreateOnStaleSocket,
  runBrowserScript,
  setAnnotationBox,
  signIn,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };
const SHOT_DIR = process.env.REVSIGN_F9_SHOTS;

const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
].join('\n');

// Onde o bloco é solto (% da página 1): longe da assinatura (y 80) e das bordas.
const DROP_AT = { x: 45, y: 30 };
const TOLERANCE = 2;

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-bloco-ui-'));

let userCookie;

const data = (res) => res.body?.result?.data?.json;

const contract = () => {
  const file = path.join(mkdtempSync(path.join(tmp, 'c-')), 'contrato.pdf');

  copyFileSync('assets/example.pdf', file);

  return file;
};

const nf = (variant) => invoicePdfFile({ variant });

// Envelope (API v2) com um signatário da empresa e uma assinatura em CADA arquivo (v.19: sem isso o diálogo não libera).
const newDraft = async (files, label) => {
  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title: `[TESTE NF] bloco conta e centro ${label} ${RUN}`,
      type: 'DOCUMENT',
      meta: { distributionMethod: 'NONE' },
      recipients: [
        {
          role: 'SIGNER',
          name: 'Teste',
          email: `bloco-ui-${label}-${RUN}@revalle.com.br`,
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

  const envelope = (await api('GET', `/envelope/${created.body.id}`)).body;
  const items = Object.fromEntries(envelope.envelopeItems.map((item) => [item.title, item.id]));
  const teamUrl = db(`select url from "Team" where id = ${Number(envelope.teamId)}`);
  const classified = await trpcAs(userCookie, 'mutation', 'revalle.invoice.classify', { envelopeId: created.body.id });

  assert.equal(classified.status, 200, classified.text);

  return { id: created.body.id, items, teamUrl, kinds: data(classified).documents.map((doc) => doc.kind) };
};

const boxOf = (envelopeItemId) => {
  const row = db(
    `select page || '|' || "positionX" || '|' || "positionY" || '|' || width || '|' || height from "RevalleInvoiceAnnotationBox" where "envelopeItemId" = '${envelopeItemId}'`,
  );

  if (!row) {
    return null;
  }

  const [page, positionX, positionY, width, height] = row.split('|').map(Number);

  return { page, positionX, positionY, width, height };
};

const fieldsOf = (envelopeId) =>
  db(
    `select type || ':' || "envelopeItemId" from "Field" where "envelopeId" = '${envelopeId}' order by "envelopeItemId"`,
  )
    .split('\n')
    .filter(Boolean);

const choose = async (envelopeId) => {
  const res = await chooseInvoice({ cookie: userCookie, envelopeId });

  assert.equal(res.status, 200, res.text);
};

const runCase = async (t, draft, browserCase) => {
  const browser = await runBrowserScript({
    script: 'invoice-annotation-box-ui.browser.mjs',
    payload: {
      baseUrl: BASE_URL,
      ownerCookie: userCookie,
      teamUrl: draft.teamUrl,
      draftId: draft.id,
      dropAt: DROP_AT,
      case: browserCase,
    },
    shotDir: SHOT_DIR,
    timeout: 240_000,
  });

  t.diagnostic(browser.stdout);
  assert.equal(browser.status, 0, `${browser.stdout}\n${browser.stderr}`);
};

const uiTest = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie) {
      t.skip('credenciais de sessão não informadas');

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
});

uiTest('arrastar o bloco para a nota, recarregar e ver no mesmo lugar', async (t) => {
  const draft = await newDraft([nf('nf-arrastar')], 'arrastar');

  assert.deepEqual(draft.kinds, ['NF']);

  await runCase(t, draft, 'drag');

  // O que a tela gravou: a página 1, com o centro onde o bloco foi solto.
  const box = boxOf(draft.items['nf-arrastar.pdf']);

  assert.ok(box, 'o bloco não foi gravado');
  assert.equal(box.page, 1);
  assert.ok(Math.abs(box.positionX + box.width / 2 - DROP_AT.x) <= TOLERANCE, `centro x fora: ${JSON.stringify(box)}`);
  assert.ok(Math.abs(box.positionY + box.height / 2 - DROP_AT.y) <= TOLERANCE, `centro y fora: ${JSON.stringify(box)}`);
  assert.equal(db(`select status from "Envelope" where id = '${draft.id}'`), 'DRAFT');
});

uiTest('sem bloco: a linha diz sem conta e centro', async (t) => {
  const draft = await newDraft([nf('nf-tirar')], 'tirar');
  const placed = await setAnnotationBox({
    cookie: userCookie,
    envelopeId: draft.id,
    envelopeItemId: draft.items['nf-tirar.pdf'],
  });

  assert.equal(placed.status, 200, placed.text);

  // O bloco posto pela rota é tirado no editor; o diálogo diz que a nota sai sem conta e centro.
  await runCase(t, draft, 'remove');

  assert.equal(boxOf(draft.items['nf-tirar.pdf']), null, 'o bloco continua gravado');
});

uiTest('bloco no contrato: aviso em âmbar e Enviar continua liberado', async (t) => {
  const draft = await newDraft([nf('nf-contrato'), contract()], 'contrato');

  assert.deepEqual(draft.kinds, ['NF', 'OTHER']);

  const placed = await setAnnotationBox({
    cookie: userCookie,
    envelopeId: draft.id,
    envelopeItemId: draft.items['contrato.pdf'],
  });

  assert.equal(placed.status, 200, placed.text);
  await choose(draft.id);

  await runCase(t, draft, 'contract');

  assert.equal(db(`select status from "Envelope" where id = '${draft.id}'`), 'DRAFT');
});

uiTest('o bloco não conta como campo de assinatura', async (t) => {
  const draft = await newDraft([nf('nf-campo'), contract()], 'campo');

  assert.deepEqual(draft.kinds, ['NF', 'OTHER']);
  await choose(draft.id);

  const before = fieldsOf(draft.id);

  assert.equal(before.length, 2);

  await runCase(t, draft, 'not-a-field');

  // O bloco foi gravado na nota e os campos continuam os mesmos: uma assinatura por arquivo, nenhum campo a mais.
  assert.equal(boxOf(draft.items['nf-campo.pdf'])?.page, 1);
  assert.equal(boxOf(draft.items['contrato.pdf']), null);
  assert.deepEqual(fieldsOf(draft.id), before);
  assert.ok(
    fieldsOf(draft.id).every((field) => field.startsWith('SIGNATURE:')),
    'só assinaturas no envio',
  );
});
