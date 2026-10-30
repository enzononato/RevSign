// Fase 5, Task 4: nota fiscal só é enviada com a conta contábil escolhida (ou "Deixar para a contabilidade decidir").
// O servidor confere no envio (sendDocument: tela, API v1 e v2), a escolha vai para o log de auditoria e pode ser
// trocada depois do envio pelo dono e pelo admin. Documento comum (assets/example.pdf) não muda em nada.
//
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN) e REVSIGN_ADMIN_* (importa a lista de contas e troca a conta
// como admin). Com o servidor falso do Gemini (compose.test.yml), também confere `acceptedSuggestion` contra a
// sugestão; sem ele, a escolha manual (sem sugestão) é conferida. Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

import {
  api,
  assertNoPaidGeminiCalls,
  BASE_URL,
  createEnvelope,
  db,
  latestMail,
  poppler,
  signIn,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const FAKE_URL = (process.env.REVSIGN_FAKE_GEMINI_URL ?? 'http://localhost:8787').replace(/\/$/, '');

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const CHAVE = '29241012345678000195550010000123451123456784';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const REQUIRED_MESSAGE = 'Escolha a conta contábil ou deixe para a contabilidade decidir.';

const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
  '1.1.01;Caixa;Dinheiro em caixa;receber',
].join('\n');
// Conta que sai da lista na reimportação (fica inativa): não pode ser escolhida.
const OLD_ACCOUNT = '9.9.99';

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-nf-envio-'));

let userCookie;
let adminCookie;
let userId;
let fakeUp = false;

const data = (res) => res.body?.result?.data?.json;
const invoice = (kind, name, input, cookie = userCookie) => trpcAs(cookie, kind, `revalle.invoice.${name}`, input);
const setChoice = (envelopeId, choice, cookie = userCookie) =>
  invoice('mutation', 'setChoice', { envelopeId, choice }, cookie);
const distribute = (envelopeId) => api('POST', '/envelope/distribute', { envelopeId });
const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);
const row = (envelopeId, columns) =>
  db(`select ${columns} from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`);
// O relógio da VM do Docker pode voltar alguns ms/s: a ordem por `createdAt` não é confiável. Os testes procuram o
// evento pelo conteúdo (`findEvent`), não pela posição.
const findEvent = (events, data) => events.find((event) => isDeepStrictEqual(event.data, data));
const accountEvents = (envelopeId) =>
  db(
    `select coalesce(json_agg(json_build_object('data', data, 'userId', "userId", 'email', email) order by "createdAt"), '[]') from "DocumentAuditLog" where "envelopeId" = '${envelopeId}' and type = 'REVALLE_INVOICE_ACCOUNT_SET'`,
  );

const fake = async (route, body) => {
  const res = await fetch(`${FAKE_URL}${route}`, body ? { method: 'POST', body: JSON.stringify(body) } : {});

  assert.equal(res.status, 200, `fake ${route}: ${res.status}`);

  return res.json();
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitSettled = async (envelopeId, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  let state;

  do {
    const res = await invoice('query', 'get', { envelopeId });

    assert.equal(res.status, 200, res.text);
    state = data(res);

    if (state.suggestionStatus !== 'PENDING') {
      return state;
    }

    await sleep(400);
  } while (Date.now() < deadline);

  return state;
};

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
const danfe = async (variant) => {
  const file = path.join(tmp, `danfe-${variant}.pdf`);

  writeFileSync(
    file,
    await textPdf([
      'DANFE - Documento Auxiliar da Nota Fiscal Eletrônica',
      'Nº 000.012.345   Série 001',
      'Chave de Acesso',
      CHAVE.replace(/(\d{4})(?=\d)/g, '$1 '),
      'Natureza da Operação: Venda de mercadoria adquirida de terceiros',
      'Emitente: Distribuidora Fictícia de Ferragens Ltda   CNPJ 12.345.678/0001-95',
      `Referência do teste: envio ${variant} ${RUN}`,
      'Valor Total da Nota: R$ 150,00',
    ]),
  );

  return file;
};

const recipient = () => ({ email: `nf-envio-${RUN}-${Math.random().toString(36).slice(2, 7)}@revalle.com.br` });

const newEnvelope = async (file, title) => {
  const created = await createEnvelope({ recipients: [recipient()], pdf: file, title: `[TESTE NF] ${title} ${RUN}` });

  assert.equal(created.status, 200, created.text);

  return created;
};

const newEnvelopeWithFiles = async (files, title) => {
  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title: `[TESTE NF] ${title} ${RUN}`,
      type: 'DOCUMENT',
      meta: { distributionMethod: 'NONE' },
      recipients: [
        {
          role: 'SIGNER',
          name: 'Teste',
          ...recipient(),
          fields: [{ type: 'SIGNATURE', page: 1, positionX: 10, positionY: 80, width: 30, height: 8 }],
        },
      ],
    }),
  );

  for (const file of files) {
    form.append('files', new File([readFileSync(file)], path.basename(file), { type: 'application/pdf' }));
  }

  const res = await fetch(`${BASE_URL}/api/v2-beta/envelope/create`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` },
    body: form,
  });
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));

  return (await api('GET', `/envelope/${body.id}`)).body;
};

const assertRefused = (res) => {
  assert.equal(res.status, 400, res.text);
  assert.ok(res.text.includes(REQUIRED_MESSAGE), res.text);
  assert.ok(res.text.includes('INVOICE_ACCOUNT_REQUIRED'), res.text);
};

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
  userId = db(`select id from "User" where email = '${user.email}'`);

  // Importa com a conta antiga e reimporta sem ela: fica inativa (como uma conta que saiu da lista do Enzo).
  for (const csv of [`${ACCOUNTS_CSV}\n${OLD_ACCOUNT};Conta antiga;Saiu da lista;pagar`, ACCOUNTS_CSV]) {
    const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv });

    assert.equal(imported.status, 200, imported.text);
  }

  assert.equal(db(`select active from "RevalleAccountingAccount" where code = '${OLD_ACCOUNT}'`), 'f');

  db(`delete from "RateLimit" where action like 'revalle.invoice%'`);

  // O caminho da IA exige o servidor falso no ar E o app subido com ele (compose.test.yml): o container do servidor
  // falso pode continuar de pé com o app já recriado sem a chave.
  const aiStatus = (await trpcAs(adminCookie, 'query', 'revalle.invoice.adminGetSettings', undefined)).body?.result
    ?.data?.json?.aiStatus;

  fakeUp =
    aiStatus === 'CONFIGURED' &&
    (await fetch(`${FAKE_URL}/__health`)
      .then((res) => res.ok)
      .catch(() => false));
});

let deferredId;

sessionTest('NF enviada pela API v2 sem passar pela tela: recusada (detecção na hora, sem esperar a IA)', async () => {
  const callsBefore = fakeUp ? (await fake('/__calls')).length : 0;
  const env = await newEnvelope(await danfe('sem-escolha'), 'sem escolha');

  assert.equal(row(env.id, 'count(*)'), '0');

  assertRefused(await distribute(env.id));
  assert.equal(status(env.id), 'DRAFT');
  // A recusa classificou o documento (só a detecção, sem chamar a IA).
  assert.equal(row(env.id, `"isInvoice" || ';' || "suggestionStatus"`), 'YES;SKIPPED');

  if (fakeUp) {
    await sleep(1000);
    assert.equal((await fake('/__calls')).length, callsBefore);
  }

  // A tela (tRPC) e a API v1 passam pela mesma conferência.
  const teamId = db(`select "teamId" from "Envelope" where id = '${env.id}'`);
  const viaScreen = await trpcAs(
    userCookie,
    'mutation',
    'envelope.distribute',
    { envelopeId: env.id },
    { 'x-team-id': teamId },
  );

  assert.equal(viaScreen.status, 400, viaScreen.text);
  assert.ok(viaScreen.text.includes('INVOICE_ACCOUNT_REQUIRED'), viaScreen.text);

  const documentId = db(`select "secondaryId" from "Envelope" where id = '${env.id}'`).replace(/\D/g, '');
  const viaV1 = await fetch(`${BASE_URL}/api/v1/documents/${documentId}/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sendEmail: false }),
  });
  const v1Text = await viaV1.text();

  assert.equal(viaV1.status, 400, v1Text);
  assert.ok(v1Text.includes(REQUIRED_MESSAGE), v1Text);
  assert.equal(status(env.id), 'DRAFT');
});

sessionTest('"Deixar para a contabilidade decidir": envia, e o log de auditoria registra a escolha', async () => {
  const env = await newEnvelope(await danfe('deixar'), 'deixar para a contabilidade');

  deferredId = env.id;

  const res = await setChoice(env.id, { defer: true });

  assert.equal(res.status, 200, res.text);
  assert.deepEqual(data(res).choice, { code: 'DEFER' });
  assert.equal(
    row(env.id, `"choiceDefer" || ';' || coalesce("choiceCode", '-') || ';' || "choiceById"`),
    `true;-;${userId}`,
  );

  const sent = await distribute(env.id);

  assert.equal(sent.status, 200, sent.text);
  assert.equal(status(env.id), 'PENDING');

  const events = JSON.parse(accountEvents(env.id));

  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data, { fromCode: null, fromDefer: false, toCode: null, toDefer: true });
  assert.equal(String(events[0].userId), userId);
});

sessionTest('conta ativa: envia, e "aceitou a sugestão" confere com a sugestão da IA', async () => {
  const env = await newEnvelope(await danfe('conta-ativa'), 'conta ativa');

  if (fakeUp) {
    await fake('/__program', { mode: 'ok', accountCode: '2.1.03' });

    const classified = await invoice('mutation', 'classify', { envelopeId: env.id });

    assert.equal(classified.status, 200, classified.text);

    const state = await waitSettled(env.id);

    assert.equal(state.suggestion?.accountCode, '2.1.03', JSON.stringify(state));
    // Sugestão nunca vira escolha sozinha.
    assert.equal(state.choice, null);
    assertRefused(await distribute(env.id));

    const other = await setChoice(env.id, { code: '3.1.01' });

    assert.equal(other.status, 200, other.text);
    assert.equal(row(env.id, `"acceptedSuggestion"`), 'f');

    // "Deixar para a contabilidade decidir" com sugestão na tela: não aceitou a sugestão.
    assert.equal((await setChoice(env.id, { defer: true })).status, 200);
    assert.equal(row(env.id, `"acceptedSuggestion" || ';' || "choiceDefer"`), 'false;true');
  }

  const chosen = await setChoice(env.id, { code: '2.1.03' });

  assert.equal(chosen.status, 200, chosen.text);
  assert.deepEqual(data(chosen).choice, { code: '2.1.03', name: 'Fornecedores' });
  // Sem servidor falso não há sugestão: "aceitou" fica vazio.
  assert.equal(row(env.id, `coalesce("acceptedSuggestion"::text, 'null')`), fakeUp ? 'true' : 'null');

  const sent = await distribute(env.id);

  assert.equal(sent.status, 200, sent.text);
  // Eventos seguidos podem ter o mesmo `createdAt` (ordem empatada): confere a presença, não a posição.
  assert.ok(
    JSON.parse(accountEvents(env.id)).some((event) => event.data.toCode === '2.1.03'),
    accountEvents(env.id),
  );
  assert.equal(row(env.id, `"choiceCode"`), '2.1.03');
});

sessionTest('conta inativa ou inexistente: 400, e nada muda', async () => {
  const env = await newEnvelope(await danfe('inativa'), 'conta inativa');

  for (const code of [OLD_ACCOUNT, `X.${RUN}`]) {
    const res = await setChoice(env.id, { code });

    assert.equal(res.status, 400, `${code}: ${res.text}`);
  }

  const malformed = await invoice('mutation', 'setChoice', { envelopeId: env.id, choice: { defer: false } });

  assert.equal(malformed.status, 400, malformed.text);
  assert.equal(row(env.id, `coalesce("choiceCode", '-') || ';' || "choiceDefer"`), '-;false');
  assert.equal(JSON.parse(accountEvents(env.id)).length, 0);
  assertRefused(await distribute(env.id));
});

sessionTest('assets/example.pdf: envia sem nada (documento comum não muda)', async () => {
  const env = await newEnvelope('assets/example.pdf', 'comum');
  const sent = await distribute(env.id);

  assert.equal(sent.status, 200, sent.text);
  assert.equal(status(env.id), 'PENDING');
  assert.equal(row(env.id, `"isInvoice"`), 'NO');

  // Escolher conta num documento que não é NF não faz sentido.
  const res = await setChoice(env.id, { defer: true });

  assert.equal(res.status, 400, res.text);
});

sessionTest('trocar a conta depois do envio: dono e admin; cada troca gera um evento', async () => {
  assert.ok(deferredId, 'depende do caso "Deixar para a contabilidade decidir"');

  const byOwner = await setChoice(deferredId, { code: '2.1.03' });

  assert.equal(byOwner.status, 200, byOwner.text);

  // Mesma escolha de novo: nada a registrar.
  assert.equal((await setChoice(deferredId, { code: '2.1.03' })).status, 200);

  const byAdmin = await setChoice(deferredId, { code: '3.1.01' }, adminCookie);

  assert.equal(byAdmin.status, 200, byAdmin.text);
  assert.deepEqual(data(byAdmin).choice, { code: '3.1.01', name: 'Serviços de terceiros' });

  const events = JSON.parse(accountEvents(deferredId));

  assert.equal(events.length, 3, JSON.stringify(events));
  assert.ok(
    findEvent(events, { fromCode: null, fromDefer: true, toCode: '2.1.03', toDefer: false }),
    JSON.stringify(events),
  );

  const byAdminEvent = findEvent(events, { fromCode: '2.1.03', fromDefer: false, toCode: '3.1.01', toDefer: false });

  assert.ok(byAdminEvent, JSON.stringify(events));
  assert.equal(byAdminEvent.email, admin.email);
  assert.equal(row(deferredId, `"choiceById"`), db(`select id from "User" where email = '${admin.email}'`));

  // Conta inativa também é recusada depois do envio.
  assert.equal((await setChoice(deferredId, { code: OLD_ACCOUNT })).status, 400);

  // A conta fica fora do log em PDF (o mesmo gerador anexa o log ao PDF selado); o histórico da tela mostra.
  const teamId = db(`select "teamId" from "Envelope" where id = '${deferredId}'`);
  const pdf = await trpcAs(
    userCookie,
    'mutation',
    'document.auditLog.download',
    { envelopeId: deferredId },
    { 'x-team-id': teamId },
  );

  assert.equal(pdf.status, 200, pdf.text);
  writeFileSync(path.join(tmp, 'log.pdf'), Buffer.from(data(pdf).data, 'base64'));

  const text = poppler(tmp, 'pdftotext -layout /pdf/log.pdf -');

  // O poppler leva segundos: o app fecha a conexão ociosa. Um GET (repetido em socket velho, ver helpers.mjs)
  // descarta a conexão morta antes do próximo POST.
  await api('GET', `/envelope/${deferredId}`);

  assert.match(text, /enviou|sent/i);
  assert.ok(!/Conta contábil|3\.1\.01|2\.1\.03|contabilidade decidir/.test(text), text);
});

sessionTest('reenvio de um documento já enviado não é bloqueado', async () => {
  assert.ok(deferredId, 'depende do caso "Deixar para a contabilidade decidir"');

  // Simula uma NF enviada sem escolha (ex.: antes desta versão): o reenvio aos destinatários continua livre.
  db(
    `update "RevalleInvoiceClassification" set "choiceCode" = null, "choiceDefer" = false where "envelopeId" = '${deferredId}'`,
  );

  const recipientIds = db(`select id from "Recipient" where "envelopeId" = '${deferredId}'`).split('\n').map(Number);
  const res = await api('POST', '/envelope/redistribute', { envelopeId: deferredId, recipients: recipientIds });

  assert.equal(res.status, 200, res.text);

  // `distribute` de novo num documento já enviado também não passa pela conferência (só o rascunho passa).
  const again = await distribute(deferredId);

  assert.ok(!again.text.includes('INVOICE_ACCOUNT_REQUIRED'), again.text);
  assert.equal(again.status, 200, again.text);
  assert.equal(status(deferredId), 'PENDING');
});

sessionTest(
  'documento enviado sem classificação (ex.: antes desta versão) é lido como NO e nada é gravado',
  async () => {
    const env = await newEnvelope(await danfe('sem-linha'), 'enviado sem linha');

    assert.equal((await setChoice(env.id, { defer: true })).status, 200);
    assert.equal((await distribute(env.id)).status, 200);
    db(`delete from "RevalleInvoiceClassification" where "envelopeId" = '${env.id}'`);

    const state = data(await invoice('query', 'get', { envelopeId: env.id }));

    assert.equal(state.isInvoice, 'NO');
    assert.equal(state.choice, null);
    assert.equal(data(await invoice('mutation', 'classify', { envelopeId: env.id })).isInvoice, 'NO');
    assert.equal(row(env.id, 'count(*)'), '0');
    assert.equal((await setChoice(env.id, { defer: true })).status, 400);
  },
);

sessionTest('depois do envio, alguém do time que não é o dono recebe 403', async () => {
  const env = await newEnvelope(await danfe('nao-dono'), 'não dono');

  assert.equal((await setChoice(env.id, { defer: true })).status, 200);
  assert.equal((await distribute(env.id)).status, 200);

  // O documento passa a ser de outra conta, no mesmo time: o usuário do teste continua vendo (é do time), mas não é
  // o dono. A outra conta é a do admin, que não é do time (o acesso dele vem do papel ADMIN).
  const ownerId = db(`select "userId" from "Envelope" where id = '${env.id}'`);
  const adminId = db(`select id from "User" where email = '${admin.email}'`);

  db(`update "Envelope" set "userId" = ${adminId} where id = '${env.id}'`);

  try {
    assert.equal((await invoice('query', 'get', { envelopeId: env.id })).status, 200);

    const res = await setChoice(env.id, { code: '2.1.03' });

    assert.equal(res.status, 403, res.text);
    assert.equal(row(env.id, `"choiceDefer"`), 't');
    assert.equal(JSON.parse(accountEvents(env.id)).length, 1);
  } finally {
    db(`update "Envelope" set "userId" = ${ownerId} where id = '${env.id}'`);
  }
});

sessionTest('escolha concorrente com troca de arquivo: a escolha não é gravada (gravação condicionada)', async () => {
  const env = await newEnvelope(await danfe('corrida-escolha'), 'corrida escolha');

  assert.equal(data(await invoice('mutation', 'classify', { envelopeId: env.id })).isInvoice, 'YES');

  // Outra transação troca a chave dos arquivos e segura a linha por 2 s (como uma reclassificação no meio). A
  // escolha lê a versão antiga e, ao gravar, espera a trava; depois disso a condição não vale mais: nada é gravado.
  const holder = spawn('docker', [
    'exec',
    '-i',
    'revsign-hml-database-1',
    'psql',
    '-U',
    'documenso',
    '-d',
    'documenso',
    '-v',
    'ON_ERROR_STOP=1',
  ]);
  const holderDone = new Promise((resolve) => holder.on('close', resolve));

  holder.stdin.end(
    `begin; update "RevalleInvoiceClassification" set "fileSha256" = 'corrida-${RUN}' where "envelopeId" = '${env.id}'; select pg_sleep(2); commit;\n`,
  );
  await sleep(700);

  const res = await setChoice(env.id, { defer: true });

  assert.equal(await holderDone, 0);
  assert.equal(res.status, 400, res.text);
  assert.match(res.text, /O documento mudou enquanto a conta era escolhida/);
  assert.equal(row(env.id, `coalesce("choiceCode", '-') || ';' || "choiceDefer"`), '-;false');
  assert.equal(JSON.parse(accountEvents(env.id)).length, 0);

  // A próxima classificação vê os arquivos de verdade e a escolha funciona.
  assert.equal(data(await invoice('mutation', 'classify', { envelopeId: env.id })).isInvoice, 'YES');
  assert.equal((await setChoice(env.id, { defer: true })).status, 200);
});

// Modelo (TEMPLATE) com o PDF de uma NF, para os fluxos de modelo.
const newInvoiceTemplate = async (variant) => {
  const created = await createEnvelope({
    type: 'TEMPLATE',
    pdf: await danfe(variant),
    title: `[TESTE NF] modelo ${variant} ${RUN}`,
    recipients: [{ email: 'recipient.1@documenso.com', name: 'Recipient 1' }],
  });

  assert.equal(created.status, 200, created.text);

  return created;
};

sessionTest(
  'usar modelo de NF com envio (API v2 /envelope/use): 400 INVOICE_ACCOUNT_REQUIRED e o rascunho fica',
  async () => {
    const template = await newInvoiceTemplate('modelo-use');
    const recipientId = template.envelope.recipients[0].id;
    const form = new FormData();

    form.append(
      'payload',
      JSON.stringify({
        envelopeId: template.id,
        distributeDocument: true,
        recipients: [{ id: recipientId, ...recipient(), name: 'Teste' }],
      }),
    );

    const res = await fetch(`${BASE_URL}/api/v2-beta/envelope/use`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` },
      body: form,
    });
    const text = await res.text();

    assert.equal(res.status, 400, text);
    assert.ok(text.includes('INVOICE_ACCOUNT_REQUIRED'), text);
    assert.ok(text.includes(REQUIRED_MESSAGE), text);

    // O documento foi criado (rascunho), à espera da conta.
    const drafts = db(
      `select status from "Envelope" where type = 'DOCUMENT' and title = '${template.envelope.title}' order by "createdAt" desc limit 1`,
    );

    assert.equal(drafts, 'DRAFT');
  },
);

sessionTest('envio em lote de modelo de NF: o e-mail de conclusão diz que é nota fiscal sem conta', async () => {
  const template = await newInvoiceTemplate('modelo-lote');
  const templateId = Number(db(`select "secondaryId" from "Envelope" where id = '${template.id}'`).replace(/\D/g, ''));
  const teamId = Number(db(`select "teamId" from "Envelope" where id = '${template.id}'`));
  const res = await trpcAs(
    userCookie,
    'mutation',
    'template.uploadBulkSend',
    {
      templateId,
      teamId,
      csv: `recipient_1_email,recipient_1_name\n${recipient().email},Teste`,
      sendImmediately: true,
    },
    { 'x-team-id': String(teamId) },
  );

  assert.equal(res.status, 200, res.text);
  assert.equal(data(res).success, true, res.text);

  let mail;

  for (let i = 0; i < 60 && !mail; i += 1) {
    const latest = await latestMail(user.email);
    const body = `${latest?.Text ?? ''}${latest?.HTML ?? ''}`;

    mail = body.includes(template.envelope.title) ? body : undefined;

    if (!mail) {
      await sleep(500);
    }
  }

  assert.ok(mail, 'o e-mail de conclusão do envio em lote não chegou');
  assert.ok(mail.includes('INVOICE_ACCOUNT_REQUIRED'), mail.slice(0, 2000));
  assert.ok(mail.includes('é uma nota fiscal'), mail.slice(0, 2000));
});

sessionTest('trocar os arquivos apaga a escolha (ela era de outro arquivo)', async () => {
  const envelope = await newEnvelopeWithFiles(['assets/example.pdf', await danfe('troca-arquivo')], 'troca de arquivo');

  assert.equal(data(await invoice('mutation', 'classify', { envelopeId: envelope.id })).isInvoice, 'YES');
  assert.equal((await setChoice(envelope.id, { defer: true })).status, 200);

  const exampleItem = envelope.envelopeItems.find((item) => item.title.startsWith('example'));

  assert.ok(exampleItem, JSON.stringify(envelope.envelopeItems.map((item) => item.title)));

  const removed = await api('POST', '/envelope/item/delete', {
    envelopeId: envelope.id,
    envelopeItemId: exampleItem.id,
  });

  assert.equal(removed.status, 200, removed.text);

  // Continua NF (o DANFE ficou), mas a escolha foi para outro conjunto de arquivos.
  const after = data(await invoice('mutation', 'classify', { envelopeId: envelope.id }));

  assert.equal(after.isInvoice, 'YES');
  assert.equal(after.choice, null);
  assert.equal(
    row(
      envelope.id,
      `coalesce("choiceCode", '-') || ';' || "choiceDefer" || ';' || coalesce("choiceById"::text, '-') || ';' || coalesce("acceptedSuggestion"::text, '-')`,
    ),
    '-;false;-;-',
  );

  // A escolha apagada vai para o histórico, com o motivo.
  const events = JSON.parse(accountEvents(envelope.id));

  assert.equal(events.length, 2, JSON.stringify(events));
  const cleared = events.find((event) => event.data.reason === 'FILES_CHANGED');

  assert.deepEqual(cleared?.data, {
    fromCode: null,
    fromDefer: true,
    toCode: null,
    toDefer: false,
    reason: 'FILES_CHANGED',
  });
  assert.equal(String(cleared.userId), userId);
  assertRefused(await distribute(envelope.id));
});

sessionTest('acesso: visitante recebe 401; usuário de outro time recebe 404', async (t) => {
  const env = await newEnvelope(await danfe('acesso'), 'acesso');
  const anonymous = await setChoice(env.id, { defer: true }, '');

  assert.equal(anonymous.status, 401, anonymous.text);

  if (!process.env.REVSIGN_SENDER_API_TOKEN) {
    t.diagnostic('REVSIGN_SENDER_API_TOKEN ausente: caso do outro time pulado');

    return;
  }

  const other = await createEnvelope({
    recipients: [recipient()],
    pdf: await danfe('outro-time'),
    title: `[TESTE NF] outro time ${RUN}`,
    apiToken: process.env.REVSIGN_SENDER_API_TOKEN,
  });

  assert.equal(other.status, 200, other.text);

  const res = await setChoice(other.id, { defer: true });

  assert.equal(res.status, 404, res.text);
  assert.equal(row(other.id, 'count(*)'), '0');
});

// NF criada como documento v1 (`internalVersion = 1`): na tela ela abre no editor antigo (`legacy_editor`), que agora
// também tem o bloco "Nota fiscal · Conta contábil". `POST /api/v1/documents` cria esse tipo de documento, mas só com
// o transporte S3 (com `NEXT_PUBLIC_UPLOAD_TRANSPORT=database`, o da stack local e da produção, responde 500); nesse
// caso o documento v1 vem de `/api/v2-beta/document/create`, que cria o mesmo tipo de envelope.
const newV1Invoice = async (variant) => {
  const file = await danfe(variant);
  const title = `[TESTE NF] v1 ${variant} ${RUN}`;
  const email = recipient().email;
  const viaV1 = await fetch(`${BASE_URL}/api/v1/documents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      meta: { distributionMethod: 'NONE' },
      recipients: [{ name: 'Teste', email, role: 'SIGNER' }],
    }),
  });
  const v1Body = await viaV1.json();

  if (viaV1.status === 200) {
    const upload = await fetch(v1Body.uploadUrl, { method: 'PUT', body: readFileSync(file) });

    assert.ok(upload.ok, `upload: ${upload.status}`);

    return {
      envelopeId: db(`select id from "Envelope" where "secondaryId" = 'document_${v1Body.documentId}'`),
      documentId: v1Body.documentId,
    };
  }

  assert.equal(viaV1.status, 500, JSON.stringify(v1Body));
  assert.match(v1Body.message, /S3 transport/);

  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title,
      meta: { distributionMethod: 'NONE' },
      recipients: [
        {
          email,
          name: 'Teste',
          role: 'SIGNER',
          fields: [{ type: 'SIGNATURE', pageNumber: 1, pageX: 10, pageY: 80, width: 30, height: 8 }],
        },
      ],
    }),
  );
  form.append('file', new File([readFileSync(file)], path.basename(file), { type: 'application/pdf' }));

  const res = await fetch(`${BASE_URL}/api/v2-beta/document/create`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` },
    body: form,
  });
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));

  return { envelopeId: body.envelopeId, documentId: body.id };
};

sessionTest(
  'NF v1 (editor antigo): envio pela API v1 recusado; o editor antigo mostra o bloco; escolhe a conta e envia',
  async () => {
    const { envelopeId, documentId } = await newV1Invoice('v1');

    assert.equal(db(`select "internalVersion" from "Envelope" where id = '${envelopeId}'`), '1');

    const send = () =>
      fetch(`${BASE_URL}/api/v1/documents/${documentId}/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sendEmail: false }),
      });

    const refused = await send();
    const refusedText = await refused.text();

    assert.equal(refused.status, 400, refusedText);
    assert.ok(refusedText.includes(REQUIRED_MESSAGE), refusedText);
    assert.equal(status(envelopeId), 'DRAFT');
    assert.equal(row(envelopeId, `"isInvoice"`), 'YES');

    // A tela do documento v1 é o editor antigo, e ele tem o bloco da NF (renderizado no servidor: "Conferindo…").
    const teamUrl = db(
      `select t.url from "Team" t join "Envelope" e on e."teamId" = t.id where e.id = '${envelopeId}'`,
    );
    const page = await fetch(`${BASE_URL}/t/${teamUrl}/documents/${envelopeId}/legacy_editor`, {
      headers: { Cookie: userCookie },
    });
    const html = await page.text();

    assert.equal(page.status, 200, html.slice(0, 500));
    assert.ok(html.includes('Conferindo se é nota fiscal'), 'o editor antigo não tem o bloco da nota fiscal');

    const chosen = await setChoice(envelopeId, { code: '2.1.03' });

    assert.equal(chosen.status, 200, chosen.text);

    const sent = await send();

    assert.equal(sent.status, 200, await sent.text());
    assert.equal(status(envelopeId), 'PENDING');
    assert.equal(row(envelopeId, `"choiceCode"`), '2.1.03');
  },
);

sessionTest(
  'marcar documento enviado como NF: dono sim (sem IA), outro do time 403, rascunho 400, já NF não muda',
  async () => {
    const callsBefore = fakeUp ? (await fake('/__calls')).length : 0;
    const env = await newEnvelope('assets/example.pdf', 'marcar como NF');
    const markAs = (cookie = userCookie) => invoice('mutation', 'markAsInvoice', { envelopeId: env.id }, cookie);

    // Rascunho: a pergunta é respondida no diálogo de envio, não aqui.
    assert.equal((await markAs()).status, 400);
    assert.equal((await distribute(env.id)).status, 200);
    assert.equal(row(env.id, `"isInvoice"`), 'NO');

    // Alguém do time que não é o dono: 403, e nada muda.
    const ownerId = db(`select "userId" from "Envelope" where id = '${env.id}'`);
    const adminId = db(`select id from "User" where email = '${admin.email}'`);

    db(`update "Envelope" set "userId" = ${adminId} where id = '${env.id}'`);

    try {
      const refused = await markAs();

      assert.equal(refused.status, 403, refused.text);
      assert.equal(row(env.id, `"isInvoice" || ';' || "detectedBy"`), 'NO;TEXT');
    } finally {
      db(`update "Envelope" set "userId" = ${ownerId} where id = '${env.id}'`);
    }

    // Visitante: 401.
    assert.equal((await markAs('')).status, 401);

    const marked = await markAs();

    assert.equal(marked.status, 200, marked.text);
    assert.equal(data(marked).isInvoice, 'YES');
    assert.equal(data(marked).detectedBy, 'SENDER');
    assert.equal(data(marked).suggestionStatus, 'SKIPPED');
    assert.equal(data(marked).choice, null);
    assert.equal(
      row(
        env.id,
        `"isInvoice" || ';' || "detectedBy" || ';' || "flagChangedById" || ';' || ("flagChangedAt" is not null)`,
      ),
      `YES;SENDER;${userId};true`,
    );

    // A conta é escolhida em seguida (dono, depois do envio).
    assert.equal((await setChoice(env.id, { defer: true })).status, 200);

    // Marcar de novo: nada muda (nem a escolha).
    assert.equal((await markAs()).status, 200);
    assert.equal(row(env.id, `"choiceDefer"`), 't');

    if (fakeUp) {
      await sleep(1000);
      assert.equal((await fake('/__calls')).length, callsBefore, 'marcar depois do envio chamou a IA');
    }
  },
);

sessionTest(
  'marcar documento enviado sem classificação (antes desta versão): o admin marca e a linha é criada',
  async () => {
    const env = await newEnvelope('assets/example.pdf', 'marcar sem linha');

    assert.equal((await distribute(env.id)).status, 200);
    db(`delete from "RevalleInvoiceClassification" where "envelopeId" = '${env.id}'`);

    const marked = await invoice('mutation', 'markAsInvoice', { envelopeId: env.id }, adminCookie);

    assert.equal(marked.status, 200, marked.text);
    assert.equal(data(marked).isInvoice, 'YES');
    assert.equal(
      row(env.id, `"isInvoice" || ';' || "detectedBy" || ';' || ("fileSha256" is not null)`),
      'YES;SENDER;true',
    );
    assert.equal(row(env.id, `"flagChangedById"`), db(`select id from "User" where email = '${admin.email}'`));
  },
);
