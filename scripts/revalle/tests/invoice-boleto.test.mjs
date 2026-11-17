// Fase 9, Task 3: boleto no mesmo envio das notas. A detecção é pelo texto (linha digitável válida ou marcas de boleto); o
// valor e o vencimento saem da linha digitável (no app, sem IA) e a IA completa o beneficiário e o CNPJ, só quando o envio
// tem pelo menos uma nota. A conferência com as notas (valor, beneficiário, vencimento) é só aviso. A IA é o servidor FALSO
// (scripts/revalle/tests/fake-gemini.mjs, subido com revalle/deploy/compose.test.yml): o pedido de boleto é o que tem
// `dueDate` no `responseSchema`, e as marcas `FAKEGEMINI:cnpj=...` no texto do boleto dizem o que a resposta traz. Sem o
// servidor falso, os casos são pulados. Nenhuma chamada ao Gemini de verdade.
//
//   - boleto que bate (nenhum aviso), valor diferente (avisa e o envio sai), beneficiário diferente, vencido;
//   - boleto sozinho não vai para a IA; PDF único com DANFE e boleto fica como nota (uma chamada de NF, nenhuma de boleto);
//   - cache do boleto pela SHA-256; o "É nota fiscal" não transforma o boleto em nota;
//   - (revisão da Task 2) "Não" → "Sim" num DANFE com contrato devolve só o DANFE à nota; o "Não" de um rascunho de antes
//     da Fase 9 vale depois da atualização; tirar a nota (tipo "outro" ou "Não") apaga a conta e o centro dela.
//
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN) e REVSIGN_ADMIN_* (importa a lista de contas). Este teste SUBSTITUI a
// lista de contas da stack local (2.1.03 e 3.1.01) e apaga os contadores de limite `revalle.invoice*`. Ver
// revalle/docs/testes.md.

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
  boletoLines,
  boletoPdfFile,
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

// O emitente das notas (na chave de acesso) e o valor que a IA falsa lê de cada uma (R$ 1.500,00).
const NF_CNPJ = '12345678000195';
const OTHER_CNPJ = '98765432000198';
const NF_AMOUNT_CENTS = 150000;

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-boleto-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userCookie;
let aiMode = 'off';
let skipReason;
const fx = {};

const data = (res) => res.body?.result?.data?.json;
const invoice = (kind, name, input, cookie = userCookie) => trpcAs(cookie, kind, `revalle.invoice.${name}`, input);

const fake = async (route, body) => {
  const res = await fetch(`${FAKE_URL}${route}`, body ? { method: 'POST', body: JSON.stringify(body) } : {});

  assert.equal(res.status, 200, `fake ${route}: ${res.status}`);

  return res.json();
};
const calls = () => fake('/__calls');
const kindsOf = (received) => received.map((call) => call.kind).sort();
const callText = (call) =>
  call.parts
    .filter((part) => part.type === 'text')
    .slice(1)
    .map((part) => part.text)
    .join('\n');

// 'AAAA-MM-DD' em Brasília, `days` dias a partir de hoje (o app confere o vencimento no dia de Brasília).
const brasiliaDay = (days) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Bahia' });
const ddmmyyyy = (isoDay) => isoDay.split('-').reverse().join('/');

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
const setFlag = async (envelopeId, isInvoice) => {
  const res = await invoice('mutation', 'setInvoiceFlag', { envelopeId, isInvoice });

  assert.equal(res.status, 200, res.text);

  return data(res);
};
const setFileKind = async (envelopeId, envelopeItemId, kind) => {
  const res = await invoice('mutation', 'setFileKind', { envelopeId, envelopeItemId, kind });

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
const clearedAccountEvents = (envelopeId) =>
  Number(
    db(
      `select count(*) from "DocumentAuditLog" where "envelopeId" = '${envelopeId}' and type = 'REVALLE_INVOICE_ACCOUNT_SET' and data->>'toCode' is null and data->>'reason' is null`,
    ),
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

// DANFE do emitente NF_CNPJ; a IA falsa lê dele R$ 1.500,00.
const danfe = (variant, extraLines = []) => {
  const accessKey = makeAccessKey({ cnpj: NF_CNPJ });

  return { accessKey, file: invoicePdfFile({ variant, accessKey, markers: { valor: '1500.00' }, extraLines }) };
};

const boleto = (variant, { amountCents = NF_AMOUNT_CENTS, dueDate = brasiliaDay(10), cnpj = NF_CNPJ } = {}) =>
  boletoPdfFile({ variant, amountCents, dueDate, cnpj, markers: { cnpj } });

// Envelope (API v2) com vários arquivos, um campo de assinatura do signatário em cada (o envio exige).
const newEnvelopeWithFiles = async (files, label) => {
  const apiToken = process.env.REVSIGN_API_TOKEN;
  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title: `[TESTE NF] boleto ${label} ${RUN}`,
      type: 'DOCUMENT',
      meta: { distributionMethod: 'NONE' },
      recipients: [
        {
          role: 'SIGNER',
          name: 'Teste',
          email: `boleto-${label}-${RUN}@revalle.com.br`,
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

  return { id: created.body.id, items };
};

const chooseSingle = async (envelopeId) => {
  const account = await invoice('mutation', 'setChoice', { envelopeId, choice: { code: '2.1.03' } });

  assert.equal(account.status, 200, account.text);

  const center = await invoice('mutation', 'setCostCenter', { envelopeId, code: '101' });

  assert.equal(center.status, 200, center.text);
};

// Envio de uma nota e um boleto, lido até o fim. Devolve o envelope, o estado e as chamadas novas da IA.
const settledNfAndBoleto = async (label, boletoFile) => {
  const before = (await calls()).length;
  const nf = danfe(`nf-${label}`);
  const env = await newEnvelopeWithFiles([nf.file, boletoFile], label);
  const first = await classify(env.id);

  assert.equal(first.isInvoice, 'YES');
  assert.deepEqual(
    first.documents.map((doc) => doc.kind),
    ['NF', 'BOLETO'],
  );

  const state = await waitSettled(env.id);

  return { env, nf, state, received: (await calls()).slice(before) };
};

// ---------- Casos ----------

const aiTest = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie) {
      t.skip('credenciais de sessão não informadas');

      return;
    }

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
  if (aiMode === 'fake') {
    await fake('/__reset', {});
  }
});

aiTest('boleto que bate: nenhum aviso', async () => {
  const dueDate = brasiliaDay(10);
  const boletoFile = boleto('boleto-bate', { dueDate });
  const { env, state, received } = await settledNfAndBoleto('bate', boletoFile);

  fx.matchBoletoFile = boletoFile;

  const doc = docOf(state, 'boleto-bate.pdf');

  assert.equal(doc.boleto.status, 'DONE', JSON.stringify(doc));
  assert.equal(doc.boleto.data.amountCents, NF_AMOUNT_CENTS);
  assert.equal(doc.boleto.data.dueDate, dueDate);
  assert.equal(doc.boleto.data.beneficiaryName, 'Fornecedor Falso LTDA');
  assert.equal(doc.boleto.data.beneficiaryCnpj, NF_CNPJ);
  assert.match(doc.boleto.data.digitableLine, /^\d{47}$/);
  assert.deepEqual(doc.boleto.warnings, []);
  // O boleto não é nota: sem posição, sem conta, e a nota não tem boleto.
  assert.equal(doc.position, null);
  assert.equal(doc.suggestion, null);
  assert.equal(docOf(state, 'nf-bate.pdf').boleto, null);
  assert.equal(state.invoiceData.totalAmountCents, NF_AMOUNT_CENTS);

  // Uma leitura de cada; a do boleto leva só o texto dele.
  assert.deepEqual(kindsOf(received), ['BOLETO', 'NF']);

  const boletoCall = received.find((call) => call.kind === 'BOLETO');

  assert.ok(callText(boletoCall).includes('Ficha de Compensa'), 'a chamada de boleto não levou o texto do boleto');
  assert.ok(!callText(boletoCall).includes('DANFE'), 'a chamada de boleto levou o texto da nota');
  assert.equal(boletoCall.accountCodeEnum, null);
  assert.equal(fileColumn(env.items['boleto-bate.pdf'], 'kind'), 'BOLETO');
});

aiTest('valor diferente avisa e não trava', async () => {
  const { env, state } = await settledNfAndBoleto('valor', boleto('boleto-valor', { amountCents: 149900 }));

  assert.deepEqual(docOf(state, 'boleto-valor.pdf').boleto.warnings, [
    {
      code: 'AMOUNT_MISMATCH',
      amountCents: 149900,
      message: 'O valor do boleto (R$ 1.499,00) não bate com nenhuma nota do envio.',
    },
  ]);

  await chooseSingle(env.id);

  const sent = await api('POST', '/envelope/distribute', { envelopeId: env.id });

  assert.equal(sent.status, 200, sent.text);
  assert.equal(db(`select status from "Envelope" where id = '${env.id}'`), 'PENDING');
});

aiTest('beneficiário diferente', async () => {
  const { state } = await settledNfAndBoleto('benef', boleto('boleto-benef', { cnpj: OTHER_CNPJ }));
  const doc = docOf(state, 'boleto-benef.pdf');

  assert.equal(doc.boleto.data.beneficiaryCnpj, OTHER_CNPJ);
  assert.deepEqual(doc.boleto.warnings, [
    { code: 'BENEFICIARY_MISMATCH', message: 'O beneficiário do boleto é diferente do emitente das notas.' },
  ]);
});

aiTest('boleto vencido', async () => {
  const yesterday = brasiliaDay(-1);
  const { state } = await settledNfAndBoleto('vencido', boleto('boleto-vencido', { dueDate: yesterday }));

  assert.deepEqual(docOf(state, 'boleto-vencido.pdf').boleto.warnings, [
    { code: 'OVERDUE', dueDate: yesterday, message: `Boleto vencido em ${ddmmyyyy(yesterday)}.` },
  ]);
});

aiTest('boleto sozinho não vai para a IA', async () => {
  const before = (await calls()).length;
  const env = await newEnvelopeWithFiles([boleto('boleto-sozinho', { amountCents: 98765 })], 'sozinho');
  const first = await classify(env.id);

  assert.equal(first.isInvoice, 'NO');
  assert.equal(first.documents.length, 1);
  assert.equal(first.documents[0].kind, 'BOLETO');

  await sleep(1500);

  const state = await getState(env.id);
  const [doc] = state.documents;

  assert.equal(doc.boleto.status, 'SKIPPED');
  // O valor e o vencimento vêm da linha digitável, sem IA.
  assert.equal(doc.boleto.data.amountCents, 98765);
  assert.equal(doc.boleto.data.beneficiaryName, null);
  assert.deepEqual(doc.boleto.warnings, []);
  assert.equal((await calls()).length, before);
});

aiTest('PDF único com DANFE e boleto fica como nota', async () => {
  const before = (await calls()).length;
  const nf = danfe('nf-com-boleto', boletoLines({ amountCents: NF_AMOUNT_CENTS, dueDate: brasiliaDay(10) }));
  const env = await newEnvelopeWithFiles([nf.file], 'junto');
  const first = await classify(env.id);

  assert.equal(first.isInvoice, 'YES');
  assert.deepEqual(
    first.documents.map((doc) => doc.kind),
    ['NF'],
  );

  const state = await waitSettled(env.id);

  assert.equal(state.suggestionStatus, 'DONE');
  assert.equal(state.documents[0].boleto, null);

  const received = (await calls()).slice(before);

  assert.deepEqual(kindsOf(received), ['NF']);
});

aiTest('cache do boleto', async () => {
  assert.ok(fx.matchBoletoFile, 'depende do caso "boleto que bate"');

  const { state, received } = await settledNfAndBoleto('cache', fx.matchBoletoFile);
  const doc = docOf(state, 'boleto-bate.pdf');

  // A nota é nova (uma chamada); o boleto é o mesmo arquivo (nenhuma).
  assert.deepEqual(kindsOf(received), ['NF']);
  assert.equal(doc.boleto.status, 'DONE');
  assert.equal(doc.boleto.data.beneficiaryName, 'Fornecedor Falso LTDA');
  assert.equal(doc.boleto.data.beneficiaryCnpj, NF_CNPJ);
});

aiTest('o boleto não passa a ser nota pelo "É nota fiscal"', async () => {
  const { env } = await settledNfAndBoleto('flag', boleto('boleto-flag'));
  const flagged = await setFlag(env.id, true);

  assert.deepEqual(
    flagged.documents.map((doc) => doc.kind),
    ['NF', 'BOLETO'],
  );
  assert.equal(fileColumn(env.items['boleto-flag.pdf'], 'kind'), 'BOLETO');
});

aiTest('"Não" e depois "Sim" num DANFE com contrato: só o DANFE volta a ser nota e vai para a IA', async () => {
  const before = (await calls()).length;
  const nf = danfe('nf-nao-sim');
  const env = await newEnvelopeWithFiles([contract(), nf.file], 'nao-sim');

  await classify(env.id);
  await waitSettled(env.id);

  const no = await setFlag(env.id, false);

  assert.deepEqual(
    no.documents.map((doc) => doc.kind),
    ['OTHER', 'OTHER'],
  );

  const yes = await setFlag(env.id, true);

  assert.equal(yes.isInvoice, 'YES');
  assert.deepEqual(
    yes.documents.map((doc) => doc.kind),
    ['OTHER', 'NF'],
  );

  await waitSettled(env.id);

  // Uma nota só: as rotas de uma nota continuam valendo sem dizer o arquivo.
  await chooseSingle(env.id);

  const received = (await calls()).slice(before);

  assert.ok(received.length >= 1);

  for (const call of received) {
    assert.equal(call.kind, 'NF');
    assert.ok(callText(call).replace(/\s/g, '').includes(nf.accessKey), 'uma chamada não foi do DANFE');
  }
});

aiTest('"Sim", "Não" e "Sim" numa nota escaneada com contrato: o contrato nunca vira nota', async () => {
  const before = (await calls()).length;
  const env = await newEnvelopeWithFiles([contract(), await scannedFile('nf-escaneada')], 'escaneada');
  const first = await classify(env.id);

  assert.deepEqual(
    first.documents.map((doc) => doc.kind),
    ['OTHER', 'UNKNOWN'],
  );

  await setFlag(env.id, true);
  await waitSettled(env.id);
  await setFlag(env.id, false);

  const yes = await setFlag(env.id, true);

  assert.deepEqual(
    yes.documents.map((doc) => doc.kind),
    ['OTHER', 'NF'],
  );

  await waitSettled(env.id);

  const received = (await calls()).slice(before);

  assert.ok(received.length >= 1);

  for (const call of received) {
    assert.equal(call.hasPdf, true);
    assert.equal(call.hasText, false, 'o texto do contrato foi para a IA');
  }
});

aiTest('rascunho de antes da Fase 9 com "Não": a resposta vale depois da atualização', async () => {
  const nf = danfe('nf-legado-nao');
  const env = await newEnvelopeWithFiles([nf.file], 'legado-nao');

  await classify(env.id);
  await waitSettled(env.id);
  await setFlag(env.id, false);

  // Como estava antes da Fase 9: a linha do envio com o "Não" do remetente e nenhuma linha de arquivo.
  db(`delete from "RevalleInvoiceFile" where "envelopeId" = '${env.id}'`);

  const before = (await calls()).length;
  const state = await classify(env.id);

  assert.equal(state.isInvoice, 'NO');
  assert.equal(state.detectedBy, 'SENDER');
  assert.deepEqual(
    state.documents.map((doc) => [doc.kind, doc.detectedBy]),
    [['OTHER', 'SENDER']],
  );

  await sleep(1500);
  assert.equal((await getState(env.id)).isInvoice, 'NO');
  assert.equal((await calls()).length, before, 'o "Não" do remetente não valeu: a nota foi para a IA');

  // O "Sim" seguinte devolve o DANFE à nota (os sinais do texto ficaram no arquivo).
  const yes = await setFlag(env.id, true);

  assert.deepEqual(
    yes.documents.map((doc) => doc.kind),
    ['NF'],
  );
});

aiTest('tirar a nota (tipo "outro" ou "Não") apaga a conta e o centro dela', async () => {
  const nf = danfe('nf-tirar');
  const env = await newEnvelopeWithFiles([contract(), nf.file], 'tirar');
  const itemId = env.items['nf-tirar.pdf'];

  await classify(env.id);
  await waitSettled(env.id);
  await chooseSingle(env.id);
  assert.equal(fileColumn(itemId, `"choiceCode" || ';' || "costCenterCode"`), '2.1.03;101');

  const other = await setFileKind(env.id, itemId, 'OTHER');

  assert.equal(docOf(other, 'nf-tirar.pdf').choice, null);
  assert.equal(fileColumn(itemId, `coalesce("choiceCode", '-') || ';' || coalesce("costCenterCode", '-')`), '-;-');
  assert.equal(clearedAccountEvents(env.id), 1);

  const back = await setFileKind(env.id, itemId, 'NF');

  assert.equal(back.choice, null);
  await waitSettled(env.id);
  await chooseSingle(env.id);

  const no = await setFlag(env.id, false);

  assert.equal(docOf(no, 'nf-tirar.pdf').kind, 'OTHER');
  assert.equal(fileColumn(itemId, `coalesce("choiceCode", '-') || ';' || coalesce("costCenterCode", '-')`), '-;-');
  assert.equal(clearedAccountEvents(env.id), 2);

  const yes = await setFlag(env.id, true);

  assert.equal(yes.choice, null);
  assert.equal(yes.costCenter, null);
});
