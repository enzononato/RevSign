// Fase 9, Task 2: várias notas fiscais no mesmo envio, gravação por arquivo (`RevalleInvoiceFile`) e uma leitura da IA por
// nota. A IA é o servidor FALSO na fronteira de rede (scripts/revalle/tests/fake-gemini.mjs, subido com
// revalle/deploy/compose.test.yml); as marcas `FAKEGEMINI:campo=valor` no texto de cada DANFE dizem o que a resposta
// daquela nota traz. Sem o servidor falso (e sem GEMINI_API_KEY no app), os casos de IA são pulados. Nenhuma chamada ao
// Gemini de verdade.
//
//   - três notas e um contrato: uma chamada por nota, só com o texto dela, cada uma com os próprios dados; o espelho na
//     linha do envio fica nulo no que é de uma nota e soma as chaves;
//   - cache por arquivo; uma nota que falha não derruba as outras; "Sugerir de novo" e o limite de 6 por nota;
//   - escolha por nota (`envelopeItemId`): sem ele, 400 `INVOICE_FILE_REQUIRED`; o envio só sai com conta e centro em
//     todas, e a recusa diz em qual falta;
//   - o tipo do arquivo pelo remetente (`setFileKind`); trocar um arquivo zera a escolha de todas as notas;
//   - mais de 20 notas: as excedentes ficam sem IA;
//   - envio antigo de dois arquivos (sem linhas de arquivo): a leitura refaz a linha da nota no DANFE, com a conta.
//
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN) e REVSIGN_ADMIN_* (importa a lista de contas). Este teste
// SUBSTITUI a lista de contas da stack local (2.1.03 e 3.1.01), apaga os contadores de limite `revalle.invoice*` e sobe por
// um instante o limite de arquivos por envio do time (volta no fim). Ver revalle/docs/testes.md.

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
  db,
  invoicePdfFile,
  makeAccessKey,
  retryCreateOnStaleSocket,
  signIn,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const FAKE_URL = (process.env.REVSIGN_FAKE_GEMINI_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
].join('\n');

const FILE_REQUIRED = 'INVOICE_FILE_REQUIRED';
const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-varias-notas-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userCookie;
let aiMode = 'off';
let skipReason;
const fx = {};
const restore = [];

const data = (res) => res.body?.result?.data?.json;
const invoice = (kind, name, input, cookie = userCookie) => trpcAs(cookie, kind, `revalle.invoice.${name}`, input);

const fake = async (route, body) => {
  const res = await fetch(`${FAKE_URL}${route}`, body ? { method: 'POST', body: JSON.stringify(body) } : {});

  assert.equal(res.status, 200, `fake ${route}: ${res.status}`);

  return res.json();
};
const calls = () => fake('/__calls');

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
const fileColumn = (envelopeItemId, column) =>
  db(`select ${column} from "RevalleInvoiceFile" where "envelopeItemId" = '${envelopeItemId}'`);
const mirror = (envelopeId, column) =>
  db(`select ${column} from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`);
const accountEvents = (envelopeId) =>
  db(
    `select coalesce(json_agg(data order by "createdAt"), '[]') from "DocumentAuditLog" where "envelopeId" = '${envelopeId}' and type = 'REVALLE_INVOICE_ACCOUNT_SET'`,
  );

// ---------- Arquivos ----------

const contract = () => {
  const file = path.join(mkdtempSync(path.join(tmp, 'c-')), 'contrato.pdf');

  copyFileSync('assets/example.pdf', file);

  return file;
};

// PDF só com desenho (sem texto): a classificação não sabe dizer se é nota.
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

const nf = (variant, markers = {}, accessKey = makeAccessKey()) => ({
  accessKey,
  file: invoicePdfFile({ variant, accessKey, markers }),
});

// Envelope (API v2) com vários arquivos, um campo de assinatura do signatário em cada (o envio exige).
const newEnvelopeWithFiles = async (files, label, { apiToken = process.env.REVSIGN_API_TOKEN } = {}) => {
  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title: `[TESTE NF] várias notas ${label} ${RUN}`,
      type: 'DOCUMENT',
      meta: { distributionMethod: 'NONE' },
      recipients: [
        {
          role: 'SIGNER',
          name: 'Teste',
          email: `varias-${label}-${RUN}@revalle.com.br`,
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

  const envelope = (await api('GET', `/envelope/${created.body.id}`, undefined, { apiToken })).body;
  const items = Object.fromEntries(envelope.envelopeItems.map((item) => [item.title, item.id]));

  return { id: created.body.id, items, teamId: envelope.teamId };
};

const choose = async (envelopeId, envelopeItemId, code = '2.1.03', costCenter = '101') => {
  const account = await invoice('mutation', 'setChoice', { envelopeId, envelopeItemId, choice: { code } });

  assert.equal(account.status, 200, account.text);

  const center = await invoice('mutation', 'setCostCenter', { envelopeId, envelopeItemId, code: costCenter });

  assert.equal(center.status, 200, center.text);

  return data(center);
};

const assertFileRequired = (res) => {
  assert.equal(res.status, 400, res.text);
  assert.ok(res.text.includes(FILE_REQUIRED), res.text);
};

// ---------- Casos ----------

const sessionTest = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie) {
      t.skip('credenciais de sessão não informadas');

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
  for (const undo of restore.reverse()) {
    undo();
  }

  if (aiMode === 'fake') {
    await fake('/__reset', {});
  }
});

aiTest('três notas e um contrato: uma chamada por nota, cada uma com os próprios dados', async () => {
  await fake('/__reset', {});

  const a = nf('nf-a', { conta: '2.1.03', fornecedor: 'Fornecedor_A', valor: '100.00' });
  const b = nf('nf-b', { conta: '3.1.01', fornecedor: 'Fornecedor_B', valor: '200.00' });
  const c = nf('nf-c', { valor: '300.00' });
  const env = await newEnvelopeWithFiles([contract(), a.file, b.file, c.file], 'tres');

  fx.three = { ...env, keys: [a.accessKey, b.accessKey, c.accessKey], b };

  const first = await classify(env.id);

  assert.equal(first.isInvoice, 'YES');
  assert.deepEqual(
    first.documents.map((doc) => doc.kind),
    ['OTHER', 'NF', 'NF', 'NF'],
  );
  assert.deepEqual(
    first.documents.map((doc) => doc.position),
    [null, { index: 1, total: 3 }, { index: 2, total: 3 }, { index: 3, total: 3 }],
  );

  const state = await waitSettled(env.id);
  const docs = ['nf-a.pdf', 'nf-b.pdf', 'nf-c.pdf'].map((title) => docOf(state, title));

  assert.deepEqual(
    docs.map((doc) => doc.suggestionStatus),
    ['DONE', 'DONE', 'DONE'],
  );
  assert.deepEqual(
    docs.map((doc) => doc.suggestion?.accountCode),
    ['2.1.03', '3.1.01', '2.1.03'],
  );
  assert.deepEqual(
    docs.map((doc) => doc.invoiceData?.totalAmountCents),
    [10000, 20000, 30000],
  );
  assert.equal(docs[0].invoiceData.supplierName, 'Fornecedor A');
  assert.equal(docs[1].invoiceData.supplierName, 'Fornecedor B');
  assert.equal(docOf(state, 'contrato.pdf').suggestionStatus, 'SKIPPED');

  // Uma chamada por nota, cada uma só com o texto dela (a linha fixa + uma parte); o contrato não vai.
  const received = await calls();

  assert.equal(received.length, 3, JSON.stringify(received.map((call) => call.markers)));

  for (const call of received) {
    const texts = call.parts.filter((part) => part.type === 'text');

    assert.equal(call.kind, 'NF');
    assert.equal(texts.length, 2, JSON.stringify(texts.map((part) => part.length)));
    assert.equal(call.hasPdf, false);
    assert.ok(texts[1].text.includes('DANFE'), 'a parte não é o texto do DANFE');
    assert.equal(
      fx.three.keys.filter((key) => texts[1].text.replace(/\s/g, '').includes(key)).length,
      1,
      'a chamada levou o texto de mais de uma nota',
    );
  }

  // Campos de cima com 2+ notas: o que é de uma nota fica nulo, a situação da IA é a agregada.
  assert.equal(state.choice, null);
  assert.equal(state.suggestion, null);
  assert.equal(state.invoiceData, null);
  assert.equal(state.suggestionStatus, 'DONE');

  // O espelho na linha do envio: sem conta, e as três chaves na ordem dos arquivos.
  assert.equal(mirror(env.id, `coalesce("choiceCode", '-')`), '-');
  assert.equal(mirror(env.id, '"accessKeys"'), `{${fx.three.keys.join(',')}}`);
});

aiTest('cache por arquivo: a mesma nota em outro envio não chama a IA', async () => {
  assert.ok(fx.three, 'depende do primeiro caso');

  const before = (await calls()).length;
  const d = nf('nf-d', { fornecedor: 'Fornecedor_D' });
  const env = await newEnvelopeWithFiles([fx.three.b.file, d.file], 'cache');

  await classify(env.id);

  const state = await waitSettled(env.id);

  assert.equal((await calls()).length, before + 1);

  const copy = docOf(state, 'nf-b.pdf');

  assert.equal(copy.suggestionStatus, 'DONE');
  assert.equal(copy.invoiceData.supplierName, 'Fornecedor B');
  assert.equal(docOf(state, 'nf-d.pdf').invoiceData.supplierName, 'Fornecedor D');
});

aiTest('uma nota falha e as outras leem', async () => {
  const x = nf('nf-x', { modo: 'error' });
  const y = nf('nf-y', { fornecedor: 'Fornecedor_Y' });
  const env = await newEnvelopeWithFiles([x.file, y.file], 'falha');

  await classify(env.id);

  const state = await waitSettled(env.id);
  const failed = docOf(state, 'nf-x.pdf');

  assert.equal(failed.suggestionStatus, 'FAILED');
  assert.equal(failed.failureReason, 'PROVIDER_ERROR');
  assert.equal(docOf(state, 'nf-y.pdf').suggestionStatus, 'DONE');
  // A situação de cima é a agregada: alguma nota falhou.
  assert.equal(state.suggestionStatus, 'FAILED');

  // Sem dizer a nota, num envio com duas: 400. Com o id da que falhou: 200, e só ela conta mais uma chamada.
  assertFileRequired(await invoice('mutation', 'resuggest', { envelopeId: env.id }));

  const again = await invoice('mutation', 'resuggest', { envelopeId: env.id, envelopeItemId: env.items['nf-x.pdf'] });

  assert.equal(again.status, 200, again.text);
  await waitSettled(env.id);
  assert.equal(fileColumn(env.items['nf-x.pdf'], '"suggestionAttempts"'), '2');
  assert.equal(fileColumn(env.items['nf-y.pdf'], '"suggestionAttempts"'), '1');
});

aiTest('limite por arquivo: seis chamadas por nota', async () => {
  assert.ok(fx.three, 'depende do primeiro caso');

  const { id: envelopeId, items } = fx.three;
  const resuggest = (envelopeItemId) => invoice('mutation', 'resuggest', { envelopeId, envelopeItemId });

  for (let i = 1; i <= 5; i += 1) {
    const res = await resuggest(items['nf-a.pdf']);

    assert.equal(res.status, 200, `resuggest ${i}: ${res.text}`);
    await waitSettled(envelopeId);
  }

  assert.equal(fileColumn(items['nf-a.pdf'], '"suggestionAttempts"'), '6');

  const sixth = await resuggest(items['nf-a.pdf']);

  assert.equal(sixth.status, 429, sixth.text);

  // Outra nota do mesmo envio tem o próprio limite.
  const other = await resuggest(items['nf-b.pdf']);

  assert.equal(other.status, 200, other.text);
  await waitSettled(envelopeId);

  // Um arquivo que não é nota deste envio: 404.
  assert.equal((await resuggest(items['contrato.pdf'])).status, 404);
});

aiTest('escolha por nota: o envio só sai com conta e centro em todas', async () => {
  assert.ok(fx.three, 'depende do primeiro caso');

  const { id: envelopeId, items } = fx.three;

  // Rotas de antes da Fase 9, sem o arquivo, num envio com três notas: 400 (nada é gravado).
  assertFileRequired(await invoice('mutation', 'setChoice', { envelopeId, choice: { code: '2.1.03' } }));
  assertFileRequired(await invoice('mutation', 'setCostCenter', { envelopeId, code: '101' }));
  // O contrato não é nota deste envio: 404.
  assert.equal(
    (
      await invoice('mutation', 'setChoice', {
        envelopeId,
        envelopeItemId: items['contrato.pdf'],
        choice: { code: '2.1.03' },
      })
    ).status,
    404,
  );

  await choose(envelopeId, items['nf-a.pdf'], '2.1.03', '101');
  await choose(envelopeId, items['nf-b.pdf'], '3.1.01', '101');

  const refused = await api('POST', '/envelope/distribute', { envelopeId });

  assert.equal(refused.status, 400, refused.text);
  assert.ok(refused.text.includes('INVOICE_ACCOUNT_REQUIRED'), refused.text);
  assert.ok(refused.text.includes('Escolha a conta contábil e o centro de custo. Falta em: nf-c.pdf.'), refused.text);
  assert.equal(db(`select status from "Envelope" where id = '${envelopeId}'`), 'DRAFT');

  await choose(envelopeId, items['nf-c.pdf'], '2.1.03', '101');

  const sent = await api('POST', '/envelope/distribute', { envelopeId });

  assert.equal(sent.status, 200, sent.text);
  assert.equal(mirror(envelopeId, '"financeStatus"'), 'PENDING_APPROVAL');

  for (const title of ['nf-a.pdf', 'nf-b.pdf', 'nf-c.pdf']) {
    assert.match(fileColumn(items[title], `"choiceCode" || ';' || "costCenterCode"`), /^(2\.1\.03|3\.1\.01);101$/);
  }

  const events = JSON.parse(accountEvents(envelopeId));

  assert.equal(events.length, 3, JSON.stringify(events));
  assert.equal(new Set(events.map((event) => event.document?.envelopeItemId)).size, 3);
  assert.deepEqual(events.map((event) => `${event.document.index}/${event.document.total}`).sort(), [
    '1/3',
    '2/3',
    '3/3',
  ]);
});

aiTest('tipo do arquivo pelo remetente', async () => {
  const danfe = nf('nf-tipo', { fornecedor: 'Fornecedor_T' });
  const env = await newEnvelopeWithFiles([await scannedFile('escaneado'), danfe.file], 'tipo');
  const first = await classify(env.id);

  assert.equal(first.isInvoice, 'YES');
  assert.equal(docOf(first, 'escaneado.pdf').kind, 'UNKNOWN');
  await waitSettled(env.id);

  const before = (await calls()).length;
  const setKind = (kind, envelopeId = env.id, envelopeItemId = env.items['escaneado.pdf'], cookie = userCookie) =>
    invoice('mutation', 'setFileKind', { envelopeId, envelopeItemId, kind }, cookie);

  const asNf = await setKind('NF');

  assert.equal(asNf.status, 200, asNf.text);

  const read = await waitSettled(env.id);
  const received = (await calls()).slice(before);

  assert.equal(received.length, 1);
  assert.equal(received[0].hasPdf, true);
  assert.equal(read.documents.filter((doc) => doc.kind === 'NF').length, 2);
  assert.equal(docOf(read, 'escaneado.pdf').detectedBy, 'SENDER');

  // Com uma escolha no arquivo, "Outro" apaga a leitura e a escolha dele; o envio continua NF (o DANFE).
  await choose(env.id, env.items['escaneado.pdf']);

  const asOther = await setKind('OTHER');

  assert.equal(asOther.status, 200, asOther.text);

  const other = docOf(data(asOther), 'escaneado.pdf');

  assert.equal(other.kind, 'OTHER');
  assert.equal(other.suggestion, null);
  assert.equal(other.choice, null);
  assert.equal(other.costCenter, null);
  assert.equal(data(asOther).isInvoice, 'YES');
  assert.equal(fileColumn(env.items['escaneado.pdf'], `coalesce("choiceCode", '-')`), '-');

  // Envio já enviado: 400.
  if (fx.three) {
    const sent = await setKind('OTHER', fx.three.id, fx.three.items['nf-a.pdf']);

    assert.equal(sent.status, 400, sent.text);
  }

  // Usuário de outro time: 404 (não revela o documento).
  if (process.env.REVSIGN_SENDER_API_TOKEN) {
    const foreign = await newEnvelopeWithFiles([nf('nf-outro-time').file], 'outro-time', {
      apiToken: process.env.REVSIGN_SENDER_API_TOKEN,
    });

    assert.equal((await setKind('OTHER', foreign.id, foreign.items['nf-outro-time.pdf'])).status, 404);
  }
});

aiTest('trocar um arquivo zera a escolha de todas as notas', async () => {
  const env = await newEnvelopeWithFiles([nf('nf-troca-1').file, nf('nf-troca-2').file, contract()], 'troca');

  await classify(env.id);
  await waitSettled(env.id);
  await choose(env.id, env.items['nf-troca-1.pdf']);
  await choose(env.id, env.items['nf-troca-2.pdf'], '3.1.01');

  const removed = await api('POST', '/envelope/item/delete', {
    envelopeId: env.id,
    envelopeItemId: env.items['contrato.pdf'],
  });

  assert.equal(removed.status, 200, removed.text);

  const after = await classify(env.id);

  assert.equal(after.isInvoice, 'YES');
  assert.deepEqual(
    after.documents.map((doc) => [doc.title, doc.choice, doc.costCenter]),
    [
      ['nf-troca-1.pdf', null, null],
      ['nf-troca-2.pdf', null, null],
    ],
  );

  const cleared = JSON.parse(accountEvents(env.id)).filter((event) => event.reason === 'FILES_CHANGED');

  assert.equal(cleared.length, 2, JSON.stringify(cleared));
  assert.deepEqual(cleared.map((event) => event.fromCode).sort(), ['2.1.03', '3.1.01']);
  assert.deepEqual(cleared.map((event) => event.document?.title).sort(), ['nf-troca-1.pdf', 'nf-troca-2.pdf']);
});

aiTest('mais de vinte arquivos: os excedentes ficam sem IA', async () => {
  assert.ok(fx.three, 'depende do primeiro caso');

  // O plano do time limita os arquivos por envio (5): sobe por um instante, para este envio.
  const claimId = db(
    `select o."organisationClaimId" from "Team" t join "Organisation" o on o.id = t."organisationId" where t.id = ${fx.three.teamId}`,
  );
  const limit = db(`select "envelopeItemCount" from "OrganisationClaim" where id = '${claimId}'`);
  const undo = () => db(`update "OrganisationClaim" set "envelopeItemCount" = ${limit} where id = '${claimId}'`);

  restore.push(undo);
  db(`update "OrganisationClaim" set "envelopeItemCount" = 30 where id = '${claimId}'`);

  let env;

  try {
    env = await newEnvelopeWithFiles(
      Array.from({ length: 22 }, (_, i) => nf(`nf-lote-${String(i + 1).padStart(2, '0')}`).file),
      'vinte',
    );
  } finally {
    undo();
  }

  const before = (await calls()).length;

  await classify(env.id);

  const state = await waitSettled(env.id, 90_000);
  const made = (await calls()).length - before;

  assert.ok(made <= 20 && made > 0, `chamadas: ${made}`);
  assert.equal(state.documents.length, 22);

  for (const title of ['nf-lote-21.pdf', 'nf-lote-22.pdf']) {
    const doc = docOf(state, title);

    assert.equal(doc.suggestionStatus, 'FAILED', title);
    assert.equal(doc.failureReason, 'RATE_LIMITED', title);
  }

  assert.equal(docOf(state, 'nf-lote-20.pdf').suggestionStatus, 'DONE');
});

sessionTest('envio antigo de dois arquivos se refaz na leitura', async () => {
  const danfe = nf('nf-antiga');
  const env = await newEnvelopeWithFiles([contract(), danfe.file], 'antigo');

  assert.equal((await classify(env.id)).isInvoice, 'YES');
  await choose(env.id, undefined, '2.1.03', '101');

  const sent = await api('POST', '/envelope/distribute', { envelopeId: env.id });

  assert.equal(sent.status, 200, sent.text);

  // Envio de antes da Fase 9: sem linha de arquivo. A linha do envio (o espelho) não perde nada.
  db(`delete from "RevalleInvoiceFile" where "envelopeId" = '${env.id}'`);
  assert.equal(mirror(env.id, `"choiceCode" || ';' || "costCenterCode"`), '2.1.03;101');

  const state = await getState(env.id);
  const rows = db(
    `select i."order" || ';' || f.kind || ';' || coalesce(f."choiceCode", '-') || ';' || coalesce(f."costCenterCode", '-')
     from "RevalleInvoiceFile" f join "EnvelopeItem" i on i.id = f."envelopeItemId"
     where f."envelopeId" = '${env.id}' order by i."order"`,
  );

  assert.equal(rows, '1;OTHER;-;-\n2;NF;2.1.03;101');
  assert.equal(state.choice.code, '2.1.03');
  assert.equal(state.costCenter.code, '101');
  assert.equal(docOf(state, 'nf-antiga.pdf').position.index, 1);
  assert.equal(mirror(env.id, `"choiceCode" || ';' || "costCenterCode"`), '2.1.03;101');
});
