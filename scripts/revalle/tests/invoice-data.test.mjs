// Fase 8, Task 1: dados da NF (fornecedor, número, valor e chave) lidos pela IA junto com a sugestão de conta. A IA é o
// servidor FALSO na fronteira de rede (scripts/revalle/tests/fake-gemini.mjs, subido com revalle/deploy/compose.test.yml);
// sem ele (e sem GEMINI_API_KEY no app), tudo aqui é pulado. Nenhuma chamada ao Gemini de verdade.
//
//   - NF enviada: `invoice.get`, a lista, a página da NF e a planilha trazem os três dados, e a página diz que foram
//     lidos pela IA (o bloco de envio e a lista, no navegador, quando a imagem do Playwright existe);
//   - o pedido ao Gemini (`/__calls`) traz os campos novos no `responseSchema`, simples, e continua com o `enum` das contas;
//   - resposta com valor em texto, fornecedor numérico, valor negativo, chave inválida ou sem os campos: a conta vale e o
//     dado ruim fica vazio;
//   - cache: o mesmo arquivo em documento novo não chama a IA e preenche os dados; a linha de antes da Fase 8 (sem
//     `supplierName`) chama a IA uma vez;
//   - "Sugerir de novo" atualiza os dados, a falha os deixa vazios (inclusive a falta de contas ativas), "Não"/"Sim" volta
//     pelo cache;
//   - nova versão (`finance.changeAccount`) copia os dados; remover um arquivo do rascunho os apaga;
//   - a tela de assinatura, a prova e o PDF selado não trazem os dados;
//   - a planilha neutraliza fórmula no título e no fornecedor.
//
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN) e REVSIGN_ADMIN_* (rsadmin: ADMIN e Financeiro). Este teste
// SUBSTITUI a lista de contas da stack local pela dele e apaga os contadores de limite `revalle.invoice*`. Ver
// revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  createEnvelope,
  db,
  distribute,
  downloadItem,
  fetchIdempotent,
  hasPlaywrightImage,
  PLAYWRIGHT_IMAGE,
  poppler,
  retryCreateOnStaleSocket,
  runBrowserScript,
  signIn,
  trpc,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const FAKE_URL = (process.env.REVSIGN_FAKE_GEMINI_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const APP_CONTAINER = 'revsign-hml-documenso-1';

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const CHAVE = '29241012345678000195550010000123451123456784';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const REASON = 'Conta de serviço, não de material.';

// O que o servidor falso devolve no modo `ok` sem `invoiceData`.
const FAKE_DATA = { supplierName: 'Fornecedor Falso LTDA', invoiceNumber: '12345', totalAmountCents: 123456 };
const FAKE_LINE = 'Fornecedor Falso LTDA · Nº 12345 · R$ 1.234,56';
const NO_DATA = { supplierName: null, invoiceNumber: null, totalAmountCents: null };

const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
].join('\n');

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-dados-nf-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flat = (text) => text.replace(/<!-- -->/g, '').replace(/\s+/g, ' ');

const fx = {};
let userCookie;
let adminCookie;
let aiMode = 'off';
let skipReason;

const data = (res) => res.body?.result?.data?.json;
const invoice = (kind, name, input, cookie = userCookie) => trpcAs(cookie, kind, `revalle.invoice.${name}`, input);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia' }).format(new Date());

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
const waitSettled = async (envelopeId, timeoutMs = 20_000) => {
  const deadline = performance.now() + timeoutMs;
  let state = await getState(envelopeId);

  while (state.suggestionStatus === 'PENDING' && performance.now() < deadline) {
    await sleep(400);
    state = await getState(envelopeId);
  }

  return state;
};

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

// ---------- Banco ----------

const columns = (envelopeId) =>
  JSON.parse(
    db(
      `select row_to_json(t) from (select "supplierName", "invoiceNumber", "totalAmountCents" from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}') t`,
    ),
  );
const asColumns = (summary) => ({
  supplierName: summary.supplierName,
  invoiceNumber: summary.invoiceNumber,
  totalAmountCents: summary.totalAmountCents,
});
const fileKey = (envelopeId) =>
  db(`select "fileSha256" from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`);
const cachedSuggestion = (sha) => {
  const json = db(`select suggestion::text from "RevalleInvoiceSuggestionCache" where "fileSha256" = '${sha}'`);

  return json ? JSON.parse(json) : null;
};
const storedSuggestion = (envelopeId) =>
  JSON.parse(db(`select suggestion::text from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`));
const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);

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

// DANFE fictício; `variant` muda o arquivo (outra SHA-256, sem cache da sugestão).
const danfe = (variant) =>
  textPdf([
    'DANFE - Documento Auxiliar da Nota Fiscal Eletrônica',
    '0 - Entrada   1 - Saída   Nº 000.012.345   Série 001',
    'Chave de Acesso',
    CHAVE.replace(/(\d{4})(?=\d)/g, '$1 '),
    'Natureza da Operação: Venda de mercadoria adquirida de terceiros',
    'Emitente: Distribuidora Fictícia de Ferragens Ltda   CNPJ 12.345.678/0001-95',
    'Destinatário: Revalle Distribuidora (fictício)',
    `Referência do teste: dados da NF ${variant} ${RUN}`,
    'Valor Total da Nota: R$ 150,00',
  ]);

const writeFixture = (name, bytes) => {
  const file = path.join(tmp, name);

  writeFileSync(file, bytes);

  return file;
};

const recipientEmail = (label) => `dados-${label}-${RUN}@revalle.com.br`;

const newEnvelope = async (file, title, label = Math.random().toString(36).slice(2, 8)) => {
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({ recipients: [{ email: recipientEmail(label) }], pdf: file, title }),
  );

  assert.equal(created.status, 200, created.text);

  return created;
};

// Rascunho já classificado, com a sugestão pronta (DONE).
const newDoneDraft = async (variant, title = `[TESTE NF] dados ${variant} ${RUN}`) => {
  const env = await newEnvelope(writeFixture(`${variant}.pdf`, await danfe(variant)), title);
  const first = await classify(env.id);

  assert.equal(first.isInvoice, 'YES');

  const state = await waitSettled(env.id);

  assert.equal(state.suggestionStatus, 'DONE', JSON.stringify(state));

  return { env, state };
};

// Rascunho → NF enviada (conta e centro escolhidos, como a tela faz).
const sendInvoice = async (envelopeId) => {
  const chosen = await chooseInvoice({ cookie: userCookie, envelopeId });

  assert.equal(chosen.status, 200, chosen.text);

  const recipients = await distribute(envelopeId);

  assert.ok(recipients.length >= 1);

  return recipients;
};

// ---------- Páginas e planilha ----------

const html = (cookie, route) =>
  fetchIdempotent(
    `${BASE_URL}${route}`,
    { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' },
    async (res) => ({ status: res.status, text: await res.text() }),
  );

const findRow = async (cookie, envelopeId) => {
  for (let page = 1; page <= 20; page += 1) {
    const res = await trpcAs(cookie, 'query', 'revalle.invoice.find', { from: today(), perPage: 100, page });

    assert.equal(res.status, 200, res.text);

    const body = data(res);
    const row = body.data.find((candidate) => candidate.id === envelopeId);

    if (row || page >= body.totalPages) {
      return row;
    }
  }

  return undefined;
};

const csvLines = async (cookie) => {
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

  return res.text.slice(1).split('\r\n').filter(Boolean);
};

// ---------- Assinatura ----------

const loadVersion = (envelopeId) => {
  const [secondaryId] = db(`select "secondaryId" from "Envelope" where id = '${envelopeId}'`).split('|');
  const [id, token, email] = db(
    `select id || '|' || token || '|' || email from "Recipient" where "envelopeId" = '${envelopeId}' order by id limit 1`,
  ).split('|');

  return {
    id: envelopeId,
    documentId: Number.parseInt(secondaryId.split('_')[1], 10),
    item: db(`select id from "EnvelopeItem" where "envelopeId" = '${envelopeId}' order by "order" limit 1`),
    recipient: {
      id: Number(id),
      token,
      email,
      fieldId: Number(db(`select id from "Field" where "envelopeId" = '${envelopeId}' and type = 'SIGNATURE' limit 1`)),
    },
  };
};

const waitStatus = async (envelopeId, wanted) => {
  for (let i = 0; i < 45 && status(envelopeId) !== wanted; i += 1) {
    await sleep(2000);
  }

  return status(envelopeId);
};

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
      t.skip(skipReason ?? 'stack sem o servidor falso do Gemini');

      return;
    }

    await fn(t);
  });

before(async () => {
  if (!user.email || !user.password || !admin.email || !admin.password) {
    skipReason = 'credenciais de sessão não informadas';

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
  fx.teamUrl = db(
    `select t.url from "Team" t join "Organisation" o on o.id = t."organisationId" where o."ownerUserId" = ${userId} limit 1`,
  );

  const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });

  assert.equal(imported.status, 200, imported.text);
  db(`delete from "RateLimit" where action like 'revalle.invoice%'`);

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
  if (aiMode === 'fake') {
    await fake('/__reset', {});
  }
});

aiTest(
  'DANFE: a IA devolve fornecedor, número e valor; get, banco, cache e o pedido ao Gemini trazem os dados',
  async () => {
    await fake('/__reset', {});
    await program({});

    const { env, state } = await newDoneDraft('principal');

    fx.main = { id: env.id, title: `[TESTE NF] dados principal ${RUN}` };

    assert.deepEqual(state.invoiceData, FAKE_DATA);
    assert.equal(state.suggestion.accountCode, '2.1.03');
    assert.deepEqual((await getState(env.id)).invoiceData, FAKE_DATA);
    assert.deepEqual(columns(env.id), asColumns(FAKE_DATA));

    // O formato gravado na sugestão e no cache ganha os quatro campos; o valor fica em reais.
    for (const stored of [storedSuggestion(env.id), cachedSuggestion(fileKey(env.id))]) {
      assert.equal(stored.supplierName, 'Fornecedor Falso LTDA');
      assert.equal(stored.invoiceNumber, '12345');
      assert.equal(stored.totalAmount, 1234.56);
      assert.equal(stored.accessKey, null);
    }

    const received = await calls();

    assert.equal(received.length, 1, JSON.stringify(received.map((call) => call.model)));

    const [call] = received;
    const schema = call.responseSchema;
    const newFields = ['supplierName', 'invoiceNumber', 'totalAmount', 'accessKey'];

    assert.deepEqual(
      Object.keys(schema.properties).sort(),
      ['accountCode', 'confidence', 'reason', ...newFields].sort(),
    );
    // Os campos novos são opcionais, aceitam null e são simples (nada de regex, tamanho ou formato que o Gemini recuse).
    assert.deepEqual([...schema.required].sort(), ['accountCode', 'confidence', 'reason']);

    for (const field of newFields) {
      const property = JSON.stringify(schema.properties[field]);

      // Forma documentada do Gemini para campo que aceita null; sem `trim()`/`finite()` no schema, o SDK manda `anyOf`.
      assert.deepEqual(
        schema.properties[field],
        { nullable: true, type: field === 'totalAmount' ? 'number' : 'string' },
        `${field} não saiu como { type, nullable: true }`,
      );
      assert.match(property, field === 'totalAmount' ? /"number"/ : /"string"/, field);
      assert.doesNotMatch(
        property,
        /pattern|minLength|maxLength|format|minimum|maximum|const/,
        `${field} não é simples`,
      );
    }

    // A trava das contas continua, com os mesmos códigos da lista do prompt.
    assert.deepEqual(
      [...call.accountCodeEnum].sort(),
      [...call.system.matchAll(/^- (\S+) — /gm)].map((match) => match[1]).sort(),
    );
    assert.ok(call.accountCodeEnum.includes('2.1.03'));

    // O prompt fixo pede os quatro campos e manda responder null, sem aspas, em vez de adivinhar: o "ou null" dentro das
    // aspas levava o modelo a escrever a palavra no campo de texto.
    assert.ok(call.system.includes('"supplierName": "<razão social do emitente>"'));
    assert.ok(
      call.system.includes(
        '"accessKey": "<chave de acesso desta nota, 44 dígitos, só números, não a de notas citadas>"',
      ),
    );
    assert.ok(
      call.system.includes(
        'Copie supplierName, invoiceNumber, totalAmount e accessKey do documento. Se um deles não estiver claro, responda null, sem aspas, em vez de adivinhar.',
      ),
    );
    assert.ok(!call.system.includes('ou null'), 'o prompt ainda tem "ou null" dentro das aspas');
  },
);

aiTest(
  'NF enviada: get, lista, página da NF e planilha trazem os três dados, e a página diz que vieram da IA',
  async () => {
    await sendInvoice(fx.main.id);

    const state = await getState(fx.main.id);

    assert.equal(state.suggestionStatus, 'DONE');
    assert.deepEqual(state.invoiceData, FAKE_DATA);

    const row = await findRow(adminCookie, fx.main.id);

    assert.ok(row, 'a NF enviada não está na lista');
    assert.deepEqual(row.invoiceData, FAKE_DATA);

    const page = await html(adminCookie, `/notas-fiscais/${fx.main.id}`);
    const text = flat(page.text);

    assert.equal(page.status, 200);
    assert.ok(text.includes('data-testid="invoice-view-data"'), 'a página da NF sem o bloco dos dados lidos');
    assert.ok(text.includes('Fornecedor: Fornecedor Falso LTDA'), 'página sem o fornecedor');
    assert.ok(text.includes('Número: 12345'), 'página sem o número');
    assert.ok(text.includes('Valor: R$ 1.234,56'), 'página sem o valor');
    assert.ok(text.includes('Lidos pela IA, confira no PDF'), 'a página não diz que foram lidos pela IA');

    const lines = await csvLines(adminCookie);
    const header = lines[0].split(';');
    const line = lines.find((candidate) => candidate.startsWith(`${fx.main.id};`));

    assert.ok(line, 'a planilha não tem a NF');
    // Os três dados vêm depois de validado_por; a chave e a marca da duplicada (Fase 8, alerta) vêm por último.
    assert.deepEqual(header.slice(-5, -2), ['fornecedor', 'numero_nf', 'valor']);
    assert.equal(
      header.indexOf('validado_por'),
      header.length - 6,
      'as colunas novas têm de vir depois de validado_por',
    );
    assert.ok(line.includes(';Fornecedor Falso LTDA;12345;1234,56;'), line);
  },
);

aiTest('tela de assinatura, prova e PDF selado não trazem os dados da IA', async () => {
  const doc = loadVersion(fx.main.id);
  const { token, fieldId, email, id: recipientId } = doc.recipient;

  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);

  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });

  const identity = await trpc('revalle.gate.confirmIdentity', { token, isMe: true });

  assert.equal(identity.status, 200, identity.text);

  const screen = flat((await html(null, `/sign/${token}`)).text);

  // É a tela de assinatura da NF (mostra a conta e o centro) e não leva o que a IA leu.
  assert.ok(screen.includes('Nota fiscal · Conta contábil: 2.1.03 – Fornecedores'), 'a tela não é a da NF');
  assert.ok(!screen.includes('Fornecedor Falso'), 'a tela de assinatura traz o fornecedor lido pela IA');
  assert.ok(!screen.includes('1.234,56'), 'a tela de assinatura traz o valor lido pela IA');

  const signed = await trpc('envelope.field.sign', {
    token,
    fieldId,
    fieldValue: { type: 'SIGNATURE', value: 'Teste Digitado' },
  });

  assert.equal(signed.status, 200, signed.text);

  const completion = await completeWithCode({ token, documentId: doc.documentId, email });

  assert.ok(completion.ok, completion.text);
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);

  const approved = await trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', { envelopeId: fx.main.id });

  assert.equal(approved.status, 200, approved.text);
  assert.equal(await waitStatus(fx.main.id, 'COMPLETED'), 'COMPLETED');

  // Prova congelada: tem a conta vista ao assinar e nada do que a IA leu.
  const proof = db(`select to_jsonb(p)::text from "RevalleSignatureProof" p where p."recipientId" = ${recipientId}`);

  assert.ok(proof.includes('2.1.03'), 'a prova não tem a conta');
  assert.ok(!proof.includes('Fornecedor Falso'), 'a prova traz o fornecedor lido pela IA');

  const code = db(`select "verificationCode" from "RevalleSignatureProof" where "recipientId" = ${recipientId}`);
  const verify = flat((await html(null, `/verificar?codigo=${encodeURIComponent(code)}`)).text);

  assert.ok(verify.includes('2.1.03'), '/verificar sem a conta');
  assert.ok(!verify.includes('Fornecedor Falso'), '/verificar traz o fornecedor lido pela IA');

  // PDF selado: o certificado tem a conta, e o texto do arquivo todo não tem os dados.
  const dir = mkdtempSync(path.join(tmp, 'selado-'));

  writeFileSync(path.join(dir, 'signed.pdf'), await downloadItem(doc.item, 'signed'));

  const pdfText = poppler(dir, 'pdftotext /pdf/signed.pdf -').replace(/\s+/g, ' ');

  assert.ok(pdfText.includes('Conta contábil: 2.1.03'), 'o certificado não tem a conta (texto do PDF não lido)');
  assert.ok(!pdfText.includes('Fornecedor Falso'), 'o PDF selado traz o fornecedor lido pela IA');
});

aiTest('valor com texto e fornecedor numérico vindos da IA: sugestão DONE com a conta e dados vazios', async () => {
  await program({ invoiceData: { totalAmount: 'abc', supplierName: 5 } });

  const before = (await calls()).length;
  const { env, state } = await newDoneDraft('texto');

  assert.equal(state.suggestion.accountCode, '2.1.03');
  assert.equal(state.suggestion.confidence, 'alta');
  assert.equal(state.failureReason, null);
  assert.equal(state.invoiceData, null);
  assert.deepEqual(columns(env.id), NO_DATA);
  assert.equal((await calls()).length, before + 1, 'a IA tem de ter sido chamada uma vez');

  // O cache guarda o resultado já limpo: a próxima cópia do arquivo não chama a IA e também fica sem dados.
  const cached = cachedSuggestion(fileKey(env.id));

  assert.equal(cached.accountCode, '2.1.03');
  assert.equal(cached.supplierName, null);
  assert.equal(cached.totalAmount, null);
});

aiTest(
  'um dado ruim não leva os bons: número como número vira texto; valor negativo e chave inválida ficam vazios',
  async () => {
    await program({
      invoiceData: { supplierName: 'Valida LTDA', invoiceNumber: 123, totalAmount: -5, accessKey: '123' },
    });

    const { env, state } = await newDoneDraft('misto');

    assert.equal(state.suggestion.accountCode, '2.1.03');
    assert.deepEqual(state.invoiceData, { supplierName: 'Valida LTDA', invoiceNumber: '123', totalAmountCents: null });
    assert.deepEqual(columns(env.id), { supplierName: 'Valida LTDA', invoiceNumber: '123', totalAmountCents: null });
    assert.equal(storedSuggestion(env.id).accessKey, null);
  },
);

aiTest('texto longo, com quebra de linha, e valor acima do que cabe: cortado, limpo e vazio', async () => {
  await program({
    invoiceData: {
      supplierName: `ACME\nLTDA ${'x'.repeat(300)}`,
      invoiceNumber: 'N'.repeat(90),
      totalAmount: 21474836.48,
    },
  });

  const { env, state } = await newDoneDraft('longo');

  assert.equal(state.invoiceData.supplierName.length, 200);
  assert.ok(state.invoiceData.supplierName.startsWith('ACME LTDA xxx'), state.invoiceData.supplierName);
  assert.equal(state.invoiceData.invoiceNumber.length, 60);
  assert.equal(state.invoiceData.totalAmountCents, null);
  assert.equal(columns(env.id).supplierName.length, 200);
});

aiTest('a palavra "null", "N/A" ou "Não informado" no lugar do dado não vai para a tela nem para a lista', async () => {
  await program({ invoiceData: { supplierName: 'NULL', invoiceNumber: 'n/a', totalAmount: 10.5 } });

  const first = await newDoneDraft('palavra-vazia-a');

  assert.deepEqual(first.state.invoiceData, { supplierName: null, invoiceNumber: null, totalAmountCents: 1050 });
  assert.deepEqual(columns(first.env.id), { supplierName: null, invoiceNumber: null, totalAmountCents: 1050 });

  await program({ invoiceData: { supplierName: 'Não informado', invoiceNumber: 'Null' } });

  const second = await newDoneDraft('palavra-vazia-b');

  assert.equal(second.state.invoiceData, null);
  assert.deepEqual(columns(second.env.id), NO_DATA);
});

aiTest('resposta com chave de acesso válida: guardada só na sugestão', async () => {
  await program({ invoiceData: { supplierName: 'ACME', accessKey: CHAVE } });

  const { env, state } = await newDoneDraft('chave');

  assert.deepEqual(state.invoiceData, { supplierName: 'ACME', invoiceNumber: null, totalAmountCents: null });
  assert.equal(storedSuggestion(env.id).accessKey, CHAVE);
  assert.equal(cachedSuggestion(fileKey(env.id)).accessKey, CHAVE);
});

aiTest('resposta sem os campos: sugestão DONE e dados vazios', async () => {
  await program({ invoiceData: null });

  const { env, state } = await newDoneDraft('sem-campos');

  assert.equal(state.suggestion.accountCode, '2.1.03');
  assert.equal(state.invoiceData, null);
  assert.deepEqual(columns(env.id), NO_DATA);
  assert.equal(storedSuggestion(env.id).supplierName, null);
});

aiTest(
  'cache: cópia do arquivo não chama a IA e preenche os dados; linha de antes da Fase 8 chama a IA uma vez',
  async () => {
    await program({});

    const bytes = await danfe('cache');
    const first = await newEnvelope(writeFixture('cache-a.pdf', bytes), `[TESTE NF] dados cache A ${RUN}`);
    let before = (await calls()).length;

    assert.equal((await classify(first.id)).isInvoice, 'YES');
    assert.deepEqual((await waitSettled(first.id)).invoiceData, FAKE_DATA);
    assert.equal((await calls()).length, before + 1);

    // Mesmo arquivo em documento novo: nenhuma chamada, dados preenchidos.
    before = (await calls()).length;

    const copy = await newEnvelope(writeFixture('cache-b.pdf', bytes), `[TESTE NF] dados cache B ${RUN}`);
    const copied = await classify(copy.id);

    assert.equal(copied.suggestionStatus, 'DONE', JSON.stringify(copied));
    assert.deepEqual(copied.invoiceData, FAKE_DATA);
    assert.deepEqual(columns(copy.id), asColumns(FAKE_DATA));
    assert.equal((await calls()).length, before, 'a cópia chamou a IA');

    // Linha de antes da Fase 8, gravada à mão: sem as chaves novas.
    const sha = fileKey(first.id);

    db(
      `insert into "RevalleInvoiceSuggestionCache" ("fileSha256", suggestion, model) values ('${sha}', '{"accountCode":"2.1.03","confidence":"alta","reason":"cache de antes da Fase 8"}'::jsonb, 'modelo-antigo') on conflict ("fileSha256") do update set suggestion = excluded.suggestion, model = excluded.model`,
    );
    await program({ invoiceData: { supplierName: 'Depois do cache antigo SA', invoiceNumber: '9', totalAmount: 9 } });
    before = (await calls()).length;

    const old = await newEnvelope(writeFixture('cache-c.pdf', bytes), `[TESTE NF] dados cache C ${RUN}`);

    await classify(old.id);

    const refreshed = await waitSettled(old.id);

    assert.equal(refreshed.suggestionStatus, 'DONE', JSON.stringify(refreshed));
    assert.equal((await calls()).length, before + 1, 'a linha antiga tem de chamar a IA exatamente uma vez');
    assert.notEqual(refreshed.suggestion.reason, 'cache de antes da Fase 8');
    assert.deepEqual(refreshed.invoiceData, {
      supplierName: 'Depois do cache antigo SA',
      invoiceNumber: '9',
      totalAmountCents: 900,
    });
    assert.equal(cachedSuggestion(sha).supplierName, 'Depois do cache antigo SA');

    // A resposta nova refez o cache no formato novo: a cópia seguinte já não chama a IA.
    before = (await calls()).length;

    const again = await newEnvelope(writeFixture('cache-d.pdf', bytes), `[TESTE NF] dados cache D ${RUN}`);
    const hit = await classify(again.id);

    assert.equal(hit.suggestionStatus, 'DONE');
    assert.equal(hit.invoiceData.supplierName, 'Depois do cache antigo SA');
    assert.equal((await calls()).length, before);
  },
);

aiTest('"Sugerir de novo" atualiza os dados; a falha os deixa vazios; Não e Sim voltam pelo cache', async () => {
  await program({});

  const { env, state } = await newDoneDraft('de-novo');

  assert.deepEqual(state.invoiceData, FAKE_DATA);

  const other = { supplierName: 'Outro Fornecedor SA', invoiceNumber: '777', totalAmountCents: 1050 };

  await program({ invoiceData: { supplierName: 'Outro Fornecedor SA', invoiceNumber: '777', totalAmount: 10.5 } });
  assert.equal((await invoice('mutation', 'resuggest', { envelopeId: env.id })).status, 200);

  const updated = await waitSettled(env.id);

  assert.equal(updated.suggestionStatus, 'DONE');
  assert.deepEqual(updated.invoiceData, other);
  assert.deepEqual(columns(env.id), asColumns(other));

  // Falha ao sugerir de novo: nenhum dado velho fica ao lado de uma sugestão que falhou.
  await fake('/__program', { mode: 'error' });
  assert.equal((await invoice('mutation', 'resuggest', { envelopeId: env.id })).status, 200);

  const failed = await waitSettled(env.id);

  assert.equal(failed.suggestionStatus, 'FAILED');
  assert.equal(failed.invoiceData, null);
  assert.deepEqual(columns(env.id), NO_DATA);

  // "Não" apaga; "Sim" volta pelo cache (a última resposta boa), sem chamar a IA.
  await program({});

  const before = (await calls()).length;
  const no = await invoice('mutation', 'setInvoiceFlag', { envelopeId: env.id, isInvoice: false });

  assert.equal(no.status, 200, no.text);
  assert.equal(data(no).invoiceData, null);
  assert.deepEqual(columns(env.id), NO_DATA);

  const yes = await invoice('mutation', 'setInvoiceFlag', { envelopeId: env.id, isInvoice: true });

  assert.equal(yes.status, 200, yes.text);
  assert.equal(data(yes).suggestionStatus, 'DONE', yes.text);
  assert.deepEqual(data(yes).invoiceData, other);
  assert.equal((await calls()).length, before, '"Sim" chamou a IA em vez de usar o cache');
});

aiTest('nova versão (Financeiro troca a conta) copia os dados, sem chamar a IA', async () => {
  await program({});

  const { env } = await newDoneDraft('versao');

  await sendInvoice(env.id);

  const before = (await calls()).length;
  const changed = await trpcAs(adminCookie, 'mutation', 'revalle.finance.changeAccount', {
    envelopeId: env.id,
    code: '3.1.01',
    reason: REASON,
  });

  assert.equal(changed.status, 200, changed.text);

  const v2 = data(changed)?.newEnvelopeId;

  assert.ok(v2, changed.text);
  assert.notEqual(v2, env.id);
  assert.deepEqual(columns(v2), asColumns(FAKE_DATA));
  assert.deepEqual(columns(env.id), asColumns(FAKE_DATA));
  assert.equal(storedSuggestion(v2).supplierName, 'Fornecedor Falso LTDA');
  assert.equal((await calls()).length, before, 'a nova versão chamou a IA');

  const row = await findRow(adminCookie, v2);

  assert.deepEqual(row?.invoiceData, FAKE_DATA);
  assert.ok(flat((await html(adminCookie, `/notas-fiscais/${v2}`)).text).includes('Fornecedor: Fornecedor Falso LTDA'));
});

aiTest(
  '"Sugerir de novo" sem nenhuma conta ativa: falha com NO_ACCOUNTS e os dados da sugestão anterior saem',
  async () => {
    await program({});

    const { env, state } = await newDoneDraft('sem-contas');

    assert.deepEqual(state.invoiceData, FAKE_DATA);
    assert.deepEqual(columns(env.id), asColumns(FAKE_DATA));

    // Sem conta ativa na lista, a nova sugestão nem chega à IA: falha na hora. Os dados da anterior não podem ficar.
    db(`update "RevalleAccountingAccount" set active = false`);

    try {
      const before = (await calls()).length;
      const resuggested = await invoice('mutation', 'resuggest', { envelopeId: env.id });

      assert.equal(resuggested.status, 200, resuggested.text);

      const after = await getState(env.id);

      assert.equal(after.suggestionStatus, 'FAILED');
      assert.equal(after.failureReason, 'NO_ACCOUNTS');
      assert.equal(after.invoiceData, null, 'os dados da sugestão anterior ficaram na tela');
      assert.deepEqual(columns(env.id), NO_DATA, 'os dados da sugestão anterior ficaram no banco');
      assert.equal((await calls()).length, before, 'a falha por falta de contas chamou a IA');
    } finally {
      const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', {
        csv: ACCOUNTS_CSV,
      });

      assert.equal(imported.status, 200, imported.text);
    }
  },
);

aiTest('remover um arquivo do rascunho apaga os dados', async () => {
  await program({});

  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title: `[TESTE NF] dados troca de arquivo ${RUN}`,
      type: 'DOCUMENT',
      meta: { distributionMethod: 'NONE' },
      recipients: [
        {
          role: 'SIGNER',
          name: 'Teste',
          email: recipientEmail('arquivos'),
          fields: [{ type: 'SIGNATURE', page: 1, positionX: 10, positionY: 80, width: 30, height: 8 }],
        },
      ],
    }),
  );

  for (const file of ['assets/example.pdf', writeFixture('danfe-troca.pdf', await danfe('troca'))]) {
    form.append('files', new File([readFileSync(file)], path.basename(file), { type: 'application/pdf' }));
  }

  const created = await fetch(`${BASE_URL}/api/v2-beta/envelope/create`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` },
    body: form,
  });
  const body = await created.json();

  assert.equal(created.status, 200, JSON.stringify(body));

  const envelope = (await api('GET', `/envelope/${body.id}`)).body;

  assert.equal((await classify(envelope.id)).isInvoice, 'YES');

  const state = await waitSettled(envelope.id);

  assert.deepEqual(state.invoiceData, FAKE_DATA);

  const danfeItem = envelope.envelopeItems.find((item) => item.title.startsWith('danfe-troca'));
  const removed = await api('POST', '/envelope/item/delete', { envelopeId: envelope.id, envelopeItemId: danfeItem.id });

  assert.equal(removed.status, 200, removed.text);

  const after = await classify(envelope.id);

  assert.equal(after.isInvoice, 'NO');
  assert.equal(after.invoiceData, null);
  assert.deepEqual(columns(envelope.id), NO_DATA);
});

aiTest('planilha baixada: título e fornecedor que parecem fórmula saem neutralizados', async () => {
  await program({ invoiceData: { supplierName: '=HYPERLINK("y")', invoiceNumber: '+55', totalAmount: 10 } });

  const { env } = await newDoneDraft('formula', '=HYPERLINK("x")');

  await sendInvoice(env.id);

  const lines = await csvLines(adminCookie);
  const line = lines.find((candidate) => candidate.startsWith(`${env.id};`));

  assert.ok(line, 'a planilha não tem a NF');
  // Título e fornecedor têm aspas, então a célula inteira fica entre aspas, com o apóstrofo na frente da fórmula.
  assert.ok(line.startsWith(`${env.id};"'=HYPERLINK(""x"")";`), line);
  assert.ok(line.includes(`;"'=HYPERLINK(""y"")";'+55;10,00;`), line);
  assert.ok(!line.includes(';=HYPERLINK') && !line.includes(';"=HYPERLINK'), 'sobrou uma célula começando com =');
});

aiTest('bloco de envio e lista mostram "Lido pela IA" (navegador)', async (t) => {
  if (!hasPlaywrightImage()) {
    t.skip(`imagem ${PLAYWRIGHT_IMAGE} ausente no Docker (docker pull ${PLAYWRIGHT_IMAGE})`);

    return;
  }

  await program({});

  const { env } = await newDoneDraft('tela');
  const browser = await runBrowserScript({
    script: 'invoice-data.browser.mjs',
    payload: {
      baseUrl: BASE_URL,
      teamUrl: fx.teamUrl,
      ownerCookie: userCookie,
      draftId: env.id,
      sentTitle: fx.main.title,
      line: FAKE_LINE,
    },
    timeout: 180_000,
  });

  t.diagnostic(browser.stdout);
  assert.equal(browser.status, 0, `${browser.stdout}\n${browser.stderr}`);
});
