// Aceite da Fase 9 (várias notas fiscais e boletos no mesmo envio; spec 2026-11-16), de ponta a ponta, num envio só com
// três notas e um boleto que bate (a soma das notas), dois signatários e a IA FALSA (scripts/revalle/tests/fake-gemini.mjs,
// subido com revalle/deploy/compose.test.yml; as marcas `FAKEGEMINI:campo=valor` no texto de cada arquivo dizem o que a
// resposta daquela chamada traz):
//   1. cada arquivo é classificado (NF, NF, NF, BOLETO); uma chamada à IA por nota e uma pelo boleto, cada nota com a
//      própria sugestão e os próprios dados; o boleto lido e sem aviso; o remetente aceita a sugestão de cada nota, escolhe
//      o centro de cada uma e envia;
//   2. uma linha por nota na lista e na planilha ("· nota 2 de 3", o valor de cada nota, cabeçalho igual);
//   3. todos assinam; o Financeiro aprova 2 de 3 (não conclui, sem selagem) e a 3ª (conclui e sela);
//   4. o Financeiro troca a conta da 2ª: v2, todos assinam de novo, as três notas voltam a aguardar o Financeiro, a 1ª e
//      a 3ª com a conta de antes;
//   5. a Contabilidade corrige o centro da 1ª: v3; todos assinam, o Financeiro aprova as três, e o PDF final da v3 tem o
//      texto azul em cada nota (a conta e o centro DELA, uma vez) e nada no boleto; o certificado lista as três notas.
// As variantes do boleto (valor, beneficiário, vencido) ficam em invoice-boleto.test.mjs; corridas e envios antigos, em
// finance-multi.test.mjs.
//
// Sem o servidor falso (e sem GEMINI_API_KEY no app), tudo é pulado. Nenhuma chamada ao Gemini de verdade.
//
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN, cria, escolhe e envia) e REVSIGN_ADMIN_* (rsadmin, marcado como
// Financeiro, importa a lista de contas). Uma conta de teste nova da Contabilidade (criada no banco, ver
// account-helpers.mjs), desmarcada no fim. Este teste SUBSTITUI a lista de contas da stack local (2.1.03 e 3.1.01) e apaga
// os contadores `RateLimit`. Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  makeAccessKey,
  poppler,
  retryCreateOnStaleSocket,
  signIn,
  trpc,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const FAKE_URL = (process.env.REVSIGN_FAKE_GEMINI_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const POPPLER_IMAGE = 'revsign-test-poppler:local';
const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const REASON = 'Conta de serviço, não de material.';
const CENTER_REASON = 'A compra foi para vendas, não para a puxada.';
const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
].join('\n');
const ACCOUNT_NAMES = { '2.1.03': 'Fornecedores', '3.1.01': 'Serviços de terceiros' };
const CENTER_NAMES = { 101: 'Puxada', 201: 'Armazém', 301: 'Administrativo', 401: 'Vendas' };

// O cabeçalho da planilha da Fase 8, byte a byte (o mesmo de acceptance-f6 e export-csv.test.ts).
const HEADER =
  'id;titulo;remetente;enviado_em;concluido_em;status;conta;nome_conta;tipo;sugestao_ia;confianca;aceitou_sugestao;link;financeiro;aprovado_por;centro_custo;nome_centro_custo;validacao_contabilidade;validado_por;fornecedor;numero_nf;valor;chave_acesso;possivel_duplicada';

// O emitente das três notas (na chave de acesso) é o beneficiário do boleto.
const NF_CNPJ = '12345678000195';

// As três notas: arquivo, o que a IA falsa sugere e lê, e o centro escolhido pelo remetente.
const NOTES = [
  { title: 'nf-a.pdf', code: '2.1.03', supplier: 'Fornecedor A', valor: '100.00', cents: 10000, center: '101' },
  { title: 'nf-b.pdf', code: '2.1.03', supplier: 'Fornecedor B', valor: '200.00', cents: 20000, center: '201' },
  { title: 'nf-c.pdf', code: '3.1.01', supplier: 'Fornecedor C', valor: '300.00', cents: 30000, center: '301' },
];
// O boleto vale a soma das notas (R$ 600,00): bate, sem aviso.
const BOLETO_CENTS = 60000;
const FILE_TITLES = [...NOTES.map((note) => note.title), 'boleto.pdf'];

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-aceite-f9-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flat = (text) => (text ?? '').replace(/\s+/g, ' ');
const count = (text, piece) => text.split(piece).length - 1;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia' }).format(new Date());
const brasiliaDay = (days) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Bahia' });

let userCookie;
let adminCookie;
let aiMode = 'off';
let skipReason;
const fx = {};

const data = (res) => res.body?.result?.data?.json;
const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);
const financeStatus = (envelopeId) =>
  db(
    `select coalesce("financeStatus"::text, '-') from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );
// Coluna da linha de arquivo de uma nota (pelo item), em texto ('-' = nulo).
const fileColumn = (envelopeItemId, column) =>
  db(`select coalesce("${column}"::text, '-') from "RevalleInvoiceFile" where "envelopeItemId" = '${envelopeItemId}'`);
const sealJobs = (documentId) =>
  Number(
    db(
      `select count(*) from "BackgroundJob" where "jobId" = 'internal.seal-document' and payload->>'documentId' = '${documentId}'`,
    ),
  );

const waitStatus = async (envelopeId, wanted, attempts = 45) => {
  for (let i = 0; i < attempts && status(envelopeId) !== wanted; i += 1) {
    await sleep(2000);
  }

  return status(envelopeId);
};

const fake = async (route, body) => {
  const res = await fetch(`${FAKE_URL}${route}`, body ? { method: 'POST', body: JSON.stringify(body) } : {});

  assert.equal(res.status, 200, `fake ${route}: ${res.status}`);

  return res.json();
};

// ---------- Estado da nota ----------

const getState = async (envelopeId) => {
  const res = await trpcAs(userCookie, 'query', 'revalle.invoice.get', { envelopeId });

  assert.equal(res.status, 200, res.text);

  return data(res);
};

// A IA ainda lendo alguma nota ou o boleto.
const isReading = (state) =>
  state.suggestionStatus === 'PENDING' ||
  state.documents.some((doc) => doc.suggestionStatus === 'PENDING' || doc.boleto?.status === 'PENDING');

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

// ---------- Lista e planilha ----------

// As linhas de um envio na lista (todas as páginas de hoje), na ordem da lista.
const rowsOf = async (cookie, envelopeId) => {
  const rows = [];

  for (let page = 1; page <= 50; page += 1) {
    const res = await trpcAs(cookie, 'query', 'revalle.invoice.find', { perPage: 100, page, from: today() });

    assert.equal(res.status, 200, res.text);
    rows.push(...data(res).data.filter((row) => row.id === envelopeId));

    if (page >= data(res).totalPages) {
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

  const [header, ...lines] = res.text.slice(1).split('\r\n').filter(Boolean);
  const names = HEADER.split(';');

  return {
    header,
    rows: lines
      .filter((line) => line.startsWith(`${envelopeId};`))
      .map((line) => Object.fromEntries(line.split(';').map((cell, index) => [names[index], cell]))),
  };
};

// ---------- Versões e assinatura ----------

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

const gate = async (token) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

// Cada signatário: o portão, a assinatura em cada um dos quatro arquivos e a conclusão com o código.
const signAll = async (doc) => {
  for (const recipient of doc.recipients) {
    assert.equal(recipient.fieldIds.length, FILE_TITLES.length, `${recipient.email} sem campo em todos os arquivos`);
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
  }
};

const approve = (envelopeId, envelopeItemId) =>
  trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', { envelopeId, envelopeItemId });

const approveAll = async (doc) => {
  for (const note of NOTES) {
    const res = await approve(doc.id, doc.items[note.title]);

    assert.equal(res.status, 200, res.text);
    assert.deepEqual(data(res), { approved: true });
  }
};

// ---------- PDF selado ----------

// Imagem PPM da página 1 (100 dpi) com a pasta gravável, para achar o azul do texto (#0070C0).
const firstPageBlue = (dir) => {
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '-v',
      `${dir}:/pdf`,
      POPPLER_IMAGE,
      'sh',
      '-c',
      'pdftoppm -r 100 -f 1 -l 1 -singlefile /pdf/signed.pdf /pdf/page',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  const ppm = readFileSync(path.join(dir, 'page.ppm'));
  const header = ppm
    .subarray(0, 30)
    .toString('latin1')
    .match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
  const width = Number(header[1]);
  const height = Number(header[2]);
  let found = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = header[0].length + (y * width + x) * 3;

      if (ppm[offset + 2] - ppm[offset] > 90 && ppm[offset + 2] > 130 && ppm[offset + 1] > 50) {
        found += 1;
      }
    }
  }

  return found;
};

// O arquivo selado: o texto todo (documento e certificado), as palavras "Conta:"/"CC:" e os pixels azuis da página 1.
const inspectSealed = async (itemId) => {
  const dir = mkdtempSync(path.join(tmp, 'selado-'));

  writeFileSync(path.join(dir, 'signed.pdf'), await downloadItem(itemId, 'signed'));

  // O `poppler` do helpers também constrói a imagem na primeira vez; a imagem da página vem depois.
  const [text, bbox] = poppler(
    dir,
    'pdftotext /pdf/signed.pdf - && echo @@@@ && pdftotext -bbox /pdf/signed.pdf -',
  ).split('@@@@');
  const words = [...bbox.matchAll(/<word [^>]*>(.*?)<\/word>/g)].map(([, word]) => word.trim());

  return {
    flat: flat(text),
    labels: words.filter((word) => word === 'Conta:' || word === 'CC:').length,
    blue: firstPageBlue(dir),
  };
};

// ---------- Casos ----------

const aceite = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie || !adminCookie) {
      t.skip('credenciais de sessão não informadas');

      return;
    }

    if (aiMode !== 'fake') {
      t.skip(skipReason ?? 'stack sem o servidor falso do Gemini');

      return;
    }

    await fn(t);
  });

// Os passos são um envio só: cada um depende do anterior.
const needs = (t, key) => {
  if (!fx[key]) {
    t.skip('depende do passo anterior');

    return false;
  }

  return true;
};

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

  const accountantEmail = `f9-aceite-contabilidade-${RUN}@revalle.com.br`;
  const accountantCookie = await sessionFor(accountantEmail);

  fx.accountant = {
    cookie: accountantCookie,
    id: Number(db(`select id from "User" where email = '${accountantEmail}'`)),
  };

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

  if (hasKey && !disabled && fakeUp) {
    aiMode = 'fake';
  } else {
    skipReason =
      hasKey && !disabled
        ? `GEMINI_API_KEY definida, mas o servidor falso não responde em ${FAKE_URL}`
        : 'IA desligada na stack (sem GEMINI_API_KEY): suba com compose.test.yml para o aceite da Fase 9';
  }
});

after(async () => {
  if (adminCookie && fx.accountant) {
    await trpcAs(adminCookie, 'mutation', 'revalle.accounting.adminSetMember', {
      userId: fx.accountant.id,
      isMember: false,
    });
  }

  if (aiMode === 'fake') {
    await fake('/__reset', {});
  }
});

beforeEach(() => {
  db('delete from "RateLimit"');
});

aceite('1. três notas e um boleto: cada arquivo classificado, uma sugestão por nota, o boleto sem aviso', async () => {
  await fake('/__reset', {});

  const files = [
    ...NOTES.map((note) =>
      invoicePdfFile({
        variant: note.title.replace('.pdf', ''),
        accessKey: makeAccessKey({ cnpj: NF_CNPJ }),
        markers: { conta: note.code, fornecedor: note.supplier.replace(' ', '_'), valor: note.valor },
        extraLines: [`aceite f9 ${RUN}`],
      }),
    ),
    boletoPdfFile({
      variant: 'boleto',
      amountCents: BOLETO_CENTS,
      dueDate: brasiliaDay(10),
      cnpj: NF_CNPJ,
      markers: { cnpj: NF_CNPJ },
    }),
  ];
  const title = `[TESTE NF] aceite fase 9 ${RUN}`;
  const emails = [1, 2].map((index) => `f9-aceite-${index}-${RUN}@revalle.com.br`);
  const form = new FormData();

  // Um campo de assinatura de cada signatário em cada arquivo (o envio exige).
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
  const items = loadItems(envelopeId);

  assert.deepEqual(Object.keys(items), FILE_TITLES);

  // Classificação de cada arquivo pelo texto.
  const classified = await trpcAs(userCookie, 'mutation', 'revalle.invoice.classify', { envelopeId });

  assert.equal(classified.status, 200, classified.text);
  assert.equal(data(classified).isInvoice, 'YES');
  assert.deepEqual(
    data(classified).documents.map((doc) => doc.kind),
    ['NF', 'NF', 'NF', 'BOLETO'],
  );
  assert.deepEqual(
    data(classified).documents.map((doc) => doc.position),
    [{ index: 1, total: 3 }, { index: 2, total: 3 }, { index: 3, total: 3 }, null],
  );

  // Uma sugestão por nota, com os dados de cada uma.
  const state = await waitSettled(envelopeId);
  const notes = NOTES.map((note) => docOf(state, note.title));

  assert.deepEqual(
    notes.map((doc) => doc.suggestionStatus),
    ['DONE', 'DONE', 'DONE'],
  );
  assert.deepEqual(
    notes.map((doc) => doc.suggestion?.accountCode),
    NOTES.map((note) => note.code),
  );
  assert.deepEqual(
    notes.map((doc) => doc.invoiceData?.supplierName),
    NOTES.map((note) => note.supplier),
  );
  assert.deepEqual(
    notes.map((doc) => doc.invoiceData?.totalAmountCents),
    NOTES.map((note) => note.cents),
  );
  // Com várias notas, os campos de cima (de uma nota só) ficam vazios.
  assert.equal(state.suggestion, null);
  assert.equal(state.invoiceData, null);

  // O boleto: lido (valor e vencimento pela linha digitável, beneficiário pela IA) e sem aviso (vale a soma das notas).
  const boleto = docOf(state, 'boleto.pdf');

  assert.equal(boleto.kind, 'BOLETO');
  assert.equal(boleto.position, null);
  assert.equal(boleto.suggestion, null);
  assert.equal(boleto.boleto?.status, 'DONE', JSON.stringify(boleto));
  assert.equal(boleto.boleto.data.amountCents, BOLETO_CENTS);
  assert.equal(boleto.boleto.data.beneficiaryCnpj, NF_CNPJ);
  assert.deepEqual(boleto.boleto.warnings, []);

  // Uma chamada por nota e uma pelo boleto; nenhuma leva o texto de outro arquivo.
  const received = await fake('/__calls');

  assert.deepEqual(received.map((call) => call.kind).sort(), ['BOLETO', 'NF', 'NF', 'NF']);

  for (const call of received) {
    const text = call.parts
      .filter((part) => part.type === 'text')
      .slice(1)
      .map((part) => part.text)
      .join('\n');

    assert.equal(
      call.kind === 'BOLETO',
      text.includes('Ficha de Compensa'),
      'a chamada levou o texto de outro arquivo',
    );
    assert.equal(call.kind === 'NF', text.includes('DANFE'), 'a chamada levou o texto de outro arquivo');
  }

  // O remetente aceita a sugestão de cada nota e escolhe o centro dela.
  for (const [index, note] of NOTES.entries()) {
    const envelopeItemId = items[note.title];
    const account = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
      envelopeId,
      envelopeItemId,
      choice: { code: notes[index].suggestion.accountCode },
    });

    assert.equal(account.status, 200, account.text);

    const center = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setCostCenter', {
      envelopeId,
      envelopeItemId,
      code: note.center,
    });

    assert.equal(center.status, 200, center.text);
  }

  for (const note of NOTES) {
    assert.equal(fileColumn(items[note.title], 'acceptedSuggestion'), 'true', `${note.title} sem a sugestão aceita`);
  }

  const sent = await api('POST', '/envelope/distribute', { envelopeId });

  assert.equal(sent.status, 200, sent.text);
  assert.equal(financeStatus(envelopeId), 'PENDING_APPROVAL');

  fx.v1 = loadVersion(envelopeId);
});

aceite('2. uma linha por nota na lista e na planilha', async (t) => {
  if (!needs(t, 'v1')) {
    return;
  }

  const doc = fx.v1;
  const rows = await rowsOf(adminCookie, doc.id);

  assert.deepEqual(
    rows.map((row) => row.envelopeItemId),
    NOTES.map((note) => doc.items[note.title]),
  );
  assert.deepEqual(
    rows.map((row) => row.position),
    [1, 2, 3].map((index) => ({ index, total: 3 })),
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
    NOTES.map((note) => note.center),
  );

  const { header, rows: cells } = await csvRowsOf(adminCookie, doc.id);

  assert.equal(header, HEADER);
  assert.deepEqual(
    cells.map((row) => row.titulo),
    [1, 2, 3].map((index) => `${doc.title} · nota ${index} de 3`),
  );
  assert.deepEqual(
    cells.map((row) => row.valor),
    ['100,00', '200,00', '300,00'],
  );
  assert.deepEqual(
    cells.map((row) => row.conta),
    NOTES.map((note) => note.code),
  );
  assert.ok(cells.every((row) => row.link.endsWith(`/notas-fiscais/${doc.id}`)));
});

aceite('3. o Financeiro aprova 2 de 3 (não conclui) e a 3ª (conclui e sela)', async (t) => {
  if (!needs(t, 'v1')) {
    return;
  }

  const doc = fx.v1;

  await signAll(doc);
  assert.equal(status(doc.id), 'PENDING');

  for (const note of NOTES.slice(0, 2)) {
    const res = await approve(doc.id, doc.items[note.title]);

    assert.equal(res.status, 200, res.text);
    assert.deepEqual(data(res), { approved: true });
  }

  await sleep(2000);
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
  assert.equal(status(doc.id), 'PENDING');
  assert.equal(sealJobs(doc.documentId), 0, 'selagem disparada antes da última nota');

  const last = await approve(doc.id, doc.items['nf-c.pdf']);

  assert.equal(last.status, 200, last.text);
  assert.deepEqual(data(last), { approved: true });
  assert.equal(financeStatus(doc.id), 'APPROVED');
  assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');
  assert.equal(sealJobs(doc.documentId), 1);

  fx.sealed = true;
});

aceite('4. troca a conta da 2ª: v2, todos assinam de novo, as três reabrem', async (t) => {
  if (!needs(t, 'sealed')) {
    return;
  }

  const v1 = fx.v1;
  const changed = await trpcAs(adminCookie, 'mutation', 'revalle.finance.changeAccount', {
    envelopeId: v1.id,
    envelopeItemId: v1.items['nf-b.pdf'],
    code: '3.1.01',
    reason: REASON,
  });

  assert.equal(changed.status, 200, changed.text);

  const v2 = loadVersion(data(changed).newEnvelopeId);

  assert.equal(financeStatus(v1.id), 'SUPERSEDED');
  assert.equal(await waitStatus(v2.id, 'PENDING', 15), 'PENDING');
  assert.equal(financeStatus(v2.id), 'PENDING_APPROVAL');
  assert.deepEqual(Object.keys(v2.items), FILE_TITLES);

  for (const recipient of v2.recipients) {
    assert.equal(recipient.signingStatus, 'NOT_SIGNED', `${recipient.email} não precisa assinar de novo`);
  }

  // A 1ª e a 3ª com a conta de antes, a 2ª com a nova; as três aguardando o Financeiro.
  assert.deepEqual(
    NOTES.map((note) => fileColumn(v2.items[note.title], 'choiceCode')),
    ['2.1.03', '3.1.01', '3.1.01'],
  );

  for (const note of NOTES) {
    assert.equal(fileColumn(v2.items[note.title], 'approvedAt'), '-', `${note.title} aprovada na v2`);
    assert.equal(fileColumn(v2.items[note.title], 'costCenterCode'), note.center);

    const card = await trpcAs(adminCookie, 'query', 'revalle.finance.get', {
      envelopeId: v2.id,
      envelopeItemId: v2.items[note.title],
    });

    assert.equal(card.status, 200, card.text);
    assert.equal(data(card).financeStatus, 'PENDING_APPROVAL', `${note.title} não reabriu`);
  }

  fx.v2 = v2;
});

aceite(
  '5. a Contabilidade corrige o centro da 1ª (v3); o PDF final tem o azul em cada nota e nada no boleto',
  async (t) => {
    if (!needs(t, 'v2')) {
      return;
    }

    const v2 = fx.v2;
    const corrected = await trpcAs(fx.accountant.cookie, 'mutation', 'revalle.accounting.changeCostCenter', {
      envelopeId: v2.id,
      envelopeItemId: v2.items['nf-a.pdf'],
      code: '401',
      reason: CENTER_REASON,
    });

    assert.equal(corrected.status, 200, corrected.text);

    const v3 = loadVersion(data(corrected).newEnvelopeId);

    assert.equal(financeStatus(v2.id), 'SUPERSEDED');
    assert.equal(await waitStatus(v3.id, 'PENDING', 15), 'PENDING');

    const finalNotes = [
      { title: 'nf-a.pdf', code: '2.1.03', center: '401' },
      { title: 'nf-b.pdf', code: '3.1.01', center: '201' },
      { title: 'nf-c.pdf', code: '3.1.01', center: '301' },
    ];

    for (const note of finalNotes) {
      assert.equal(fileColumn(v3.items[note.title], 'choiceCode'), note.code);
      assert.equal(fileColumn(v3.items[note.title], 'costCenterCode'), note.center);
      assert.equal(fileColumn(v3.items[note.title], 'approvedAt'), '-', `${note.title} aprovada na v3`);
    }

    await signAll(v3);
    assert.equal(status(v3.id), 'PENDING');
    await approveAll(v3);
    assert.equal(await waitStatus(v3.id, 'COMPLETED'), 'COMPLETED');

    // Cada nota com a conta e o centro DELA, uma vez, em azul.
    for (const note of finalNotes) {
      const sealed = await inspectSealed(v3.items[note.title]);
      const accountLine = `Conta: ${note.code} - ${ACCOUNT_NAMES[note.code]}`;
      const centerLine = `CC: ${note.center} - ${CENTER_NAMES[note.center]}`;

      assert.equal(count(sealed.flat, accountLine), 1, `${note.title}: "${accountLine}" não aparece uma vez`);
      assert.equal(count(sealed.flat, centerLine), 1, `${note.title}: "${centerLine}" não aparece uma vez`);
      assert.equal(sealed.labels, 2, `${note.title}: Conta:/CC: de outra nota`);
      assert.ok(sealed.blue > 600, `${note.title}: sem o texto azul (${sealed.blue} pixels)`);

      // O certificado de cada arquivo lista as três notas.
      for (const [index, other] of finalNotes.entries()) {
        const prefix = `Nota ${index + 1} de 3 (${other.title}): `;

        assert.ok(
          sealed.flat.includes(
            `${prefix}Conta contábil: ${other.code} – ${ACCOUNT_NAMES[other.code]} · aprovada pelo Financeiro (`,
          ),
          `${note.title}: certificado sem a conta da nota ${index + 1}`,
        );
        assert.ok(
          sealed.flat.includes(`${prefix}Centro de custo: ${other.center} – ${CENTER_NAMES[other.center]}`),
          `${note.title}: certificado sem o centro da nota ${index + 1}`,
        );
      }
    }

    // Nada no boleto: nem o texto, nem azul.
    const boleto = await inspectSealed(v3.items['boleto.pdf']);

    assert.equal(boleto.labels, 0, 'o boleto recebeu Conta: ou CC:');
    assert.equal(boleto.blue, 0, 'o boleto tem azul');
    assert.ok(boleto.flat.includes('Ficha de Compensa'), 'o arquivo selado não é o boleto');
  },
);
