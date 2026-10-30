// Aceite da Fase 5 (nota fiscal com conta contábil sugerida; spec §8, §9 e §11). Roda contra a stack local, de ponta a
// ponta, na ordem do plano:
//   1. o admin importa 4 contas e define o prompt e o e-mail da contabilidade;
//   2. um remetente da empresa (conta nova, criada pelo teste) sobe um DANFE fictício; a sugestão sai e ele aceita;
//   3. segundo documento: NFS-e com "Deixar para a contabilidade decidir";
//   4. terceiro documento: contrato comum;
//   5. dois signatários assinam cada NF (portão + código por e-mail); as NFs são concluídas;
//   6. a página "Notas fiscais" (rota `revalle.invoice.find`) lista as 2 NFs para o remetente, 0 para um terceiro
//      usuário sem envolvimento, só a NF em que é signatário para um colega, e as 2 para o admin; filtros;
//   7. a planilha (`/notas-fiscais/csv`) tem BOM, o cabeçalho exato, 2 linhas e as contas certas, e respeita os filtros;
//   8. chegaram 2 e-mails para a contabilidade;
//   9. a política de privacidade tem a frase da spec §9 e diz com exatidão o que acontece com o CPF;
//  10. o PDF selado (com o certificado e o log anexados) não tem o número nem o nome da conta.
//  11. o remetente exclui a NFS-e: some para ele e o admin continua vendo, marcada "excluído pelo remetente".
//
// Com o servidor falso do Gemini (compose.test.yml) a sugestão do passo 2 sai de verdade; sem ele (sem chave), o
// remetente escolhe a mesma conta na lista e a planilha fica sem sugestão (o resto do aceite é igual).
// Sessão: REVSIGN_ADMIN_* (conta ADMIN). O remetente, o terceiro e o colega são contas novas a cada execução.
// O prompt e o e-mail da contabilidade anteriores são restaurados no final. Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

import {
  api,
  assertNoPaidGeminiCalls,
  BASE_URL,
  completeWithCode,
  createEnvelope,
  db,
  distribute,
  downloadItem,
  fetchIdempotent,
  poppler,
  retryCreateOnStaleSocket,
  signIn,
  trpc,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const FAKE_URL = (process.env.REVSIGN_FAKE_GEMINI_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const MAILPIT = 'http://localhost:8025/api/v1';
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };
const SKIP = !admin.email || !admin.password ? 'defina REVSIGN_ADMIN_EMAIL e REVSIGN_ADMIN_PASSWORD' : false;

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = `Aceite-F5-${RUN}!`;
const ACCOUNTING = `contabilidade-f5-${RUN}@revalle.com.br`;
const PROMPT = `Prompt do aceite da Fase 5 (${RUN}): fornecedores de mercadoria vão para 4.1.07.`;
const CHAVE = '29241012345678000195550010000123451123456784';
const PRIVACY_SENTENCE =
  'As notas fiscais enviadas para assinatura são analisadas por um serviço de inteligência artificial (Google Gemini) apenas para sugerir a conta contábil.';
// O que de fato vai ao Gemini: o texto com o CPF mascarado; a NF digitalizada vai como imagem, sem máscara possível.
const PRIVACY_CPF_SENTENCE =
  'No texto da nota, números de CPF são mascarados antes do envio; uma nota digitalizada (imagem) é enviada como está. Nunca enviamos a data de nascimento nem os dados da verificação de quem assina.';
// Números e nomes que não aparecem por acaso num PDF (datas, IPs, hashes), para o passo 10 valer.
const ACCOUNTS = [
  { code: '4.1.07', name: 'Fornecedores Aceite Cinco', kind: 'pagar' },
  { code: '4.2.19', name: 'Serviços Tomados Aceite Cinco', kind: 'pagar' },
  { code: '5.3.44', name: 'Clientes Aceite Cinco', kind: 'receber' },
  { code: '6.8.71', name: 'Despesas Diversas Aceite Cinco', kind: '' },
];
const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  ...ACCOUNTS.map((a) => `${a.code};${a.name};Conta do aceite da Fase 5;${a.kind}`),
].join('\n');
const HEADER =
  'id;titulo;remetente;enviado_em;concluido_em;status;conta;nome_conta;tipo;sugestao_ia;confianca;aceitou_sugestao;link';

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-aceite-f5-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const origin = new URL(BASE_URL).origin;

const fx = {};
let adminCookie;
let previous;
let fakeUp = false;

// ---------- Contas novas (cadastro, confirmação pelo link do Mailpit e login) ----------

const mailpit = (route) => fetchIdempotent(`${MAILPIT}${route}`, {}, (res) => res.json());

const emailsTo = async (to) => (await mailpit(`/search?query=${encodeURIComponent(`to:${to}`)}`)).messages ?? [];

const waitMails = async (to, minimum, filter = () => true, timeoutMs = 40_000) => {
  const deadline = Date.now() + timeoutMs;
  let found = [];

  do {
    found = (await emailsTo(to)).filter(filter);

    if (found.length >= minimum) {
      return found;
    }

    await sleep(500);
  } while (Date.now() < deadline);

  return found;
};

const newAccount = async (label) => {
  const email = `f5-${label}-${RUN}@revalle.com.br`;
  const created = await fetch(`${BASE_URL}/api/auth/email-password/signup`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Forwarded-For': `203.0.113.${Math.floor(Math.random() * 250) + 1}`,
    },
    body: JSON.stringify({ name: `Aceite F5 ${label}`, email, password: PASSWORD }),
  });

  assert.ok(created.ok, `cadastro de ${label} falhou (${created.status}): ${await created.text()}`);

  const [message] = await waitMails(email, 1);

  assert.ok(message, `e-mail de confirmação de ${label} não chegou`);

  const html = (await mailpit(`/message/${message.ID}`)).HTML ?? '';
  const token = html.match(/\/verify-email\/([A-Za-z0-9_-]+)/)?.[1];

  assert.ok(token, `link de confirmação ausente para ${label}`);

  const verified = await fetch(`${BASE_URL}/api/auth/email-password/verify-email`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  assert.equal(verified.status, 200, await verified.text());

  return { email, name: `Aceite F5 ${label}`, cookie: await signIn(email, PASSWORD) };
};

// ---------- Ajudantes do fluxo ----------

const data = (res) => res.body?.result?.data?.json;

const fake = async (route, body) => {
  const res = await fetch(`${FAKE_URL}${route}`, body ? { method: 'POST', body: JSON.stringify(body) } : {});

  assert.equal(res.status, 200, `fake ${route}: ${res.status}`);

  return res.json();
};

const getSettings = async () => {
  const res = await trpcAs(adminCookie, 'query', 'revalle.invoice.adminGetSettings', undefined);

  assert.equal(res.status, 200, res.text);

  return data(res);
};

const saveSettings = async ({ prompt, accountingEmail }) => {
  const res = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminUpdateSettings', {
    prompt,
    accountingEmail,
  });

  assert.equal(res.status, 200, res.text);
};

const textPdf = async (name, lines) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  let y = 800;

  for (const line of lines) {
    page.drawText(line, { x: 40, y, size: 10, font, color: rgb(0, 0, 0) });
    y -= 16;
  }

  const file = path.join(tmp, name);

  writeFileSync(file, Buffer.from(await doc.save()));

  return file;
};

const danfePdf = () =>
  textPdf('danfe.pdf', [
    'DANFE - Documento Auxiliar da Nota Fiscal Eletrônica',
    'Nº 000.012.345   Série 001',
    'Chave de Acesso',
    CHAVE.replace(/(\d{4})(?=\d)/g, '$1 '),
    'Natureza da Operação: Venda de mercadoria adquirida de terceiros',
    'Emitente: Distribuidora Fictícia de Ferragens Ltda   CNPJ 12.345.678/0001-95',
    `Referência do teste: aceite F5 ${RUN}`,
    'Valor Total da Nota: R$ 150,00',
  ]);

const nfsePdf = () =>
  textPdf('nfse.pdf', [
    'Prefeitura Municipal de Salvador (fictício)',
    'NFS-e - Nota Fiscal de Serviço Eletrônica   Número 2024000777',
    'Prestador: Manutenções Fictícias S/A   CNPJ 12.345.678/0001-95   Inscrição Municipal 998877',
    'Tomador: Revalle Distribuidora (fictício)',
    'Discriminação dos Serviços: manutenção preventiva de empilhadeiras',
    `Referência do teste: aceite F5 ${RUN}`,
    'Valor dos Serviços: R$ 980,00   ISS retido: R$ 49,00',
  ]);

const create = async ({ label, pdf, signers }) => {
  const title = `[TESTE F5] ${label} ${RUN}`;
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({
      title,
      pdf,
      apiToken: fx.senderToken,
      recipients: signers.map((email, index) => ({
        email,
        name: `Signatário ${index + 1}`,
        fields: [{ type: 'SIGNATURE', page: 1, positionX: 10, positionY: 60 + index * 12, width: 30, height: 8 }],
      })),
    }),
  );

  assert.equal(created.status, 200, created.text);

  return { id: created.id, title, envelope: created.envelope, item: created.envelope.envelopeItems[0] };
};

const getState = async (envelopeId) => {
  const res = await trpcAs(fx.sender.cookie, 'query', 'revalle.invoice.get', { envelopeId });

  assert.equal(res.status, 200, res.text);

  return data(res);
};

const waitSuggestion = async (envelopeId) => {
  for (let i = 0; i < 60; i += 1) {
    const state = await getState(envelopeId);

    if (state.suggestionStatus !== 'PENDING') {
      return state;
    }

    await sleep(400);
  }

  throw new Error('a sugestão não terminou');
};

const setChoice = async (envelopeId, choice) => {
  const res = await trpcAs(fx.sender.cookie, 'mutation', 'revalle.invoice.setChoice', { envelopeId, choice });

  assert.equal(res.status, 200, res.text);

  return data(res);
};

const waitStatus = async (envelopeId, wanted) => {
  for (let i = 0; i < 60 && db(`select status from "Envelope" where id = '${envelopeId}'`) !== wanted; i += 1) {
    await sleep(2000);
  }

  return db(`select status from "Envelope" where id = '${envelopeId}'`);
};

// Portão (termo, CPF + data de nascimento da Maria fictícia, "sou eu"), assinatura e conclusão com o código.
const signAll = async (doc) => {
  const recipients = await distribute(doc.id, { apiToken: fx.senderToken });
  const documentId = Number.parseInt(doc.envelope.secondaryId.split('_')[1], 10);

  for (const recipient of recipients) {
    const field = doc.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');

    db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
    db('delete from "RateLimit"');
    await trpc('revalle.gate.acceptTerm', { token: recipient.token, termVersion: '1' });
    await trpc('revalle.gate.verifyIdentity', { token: recipient.token, ...MARIA });
    await trpc('revalle.gate.confirmIdentity', { token: recipient.token, isMe: true });

    const signed = await trpc('envelope.field.sign', {
      token: recipient.token,
      fieldId: field.id,
      fieldValue: { type: 'SIGNATURE', value: 'Teste Digitado' },
    });

    assert.equal(signed.status, 200, signed.text);

    const completion = await completeWithCode({ token: recipient.token, documentId, email: recipient.email });

    assert.ok(completion.ok, completion.text);
  }

  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');
};

const find = async (cookie, input = {}) => {
  const res = await trpcAs(cookie, 'query', 'revalle.invoice.find', { perPage: 100, ...input });

  assert.equal(res.status, 200, res.text);

  return data(res);
};

const csv = (cookie, query = '') =>
  fetchIdempotent(
    `${BASE_URL}/notas-fiscais/csv${query}`,
    { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' },
    async (res) => ({
      status: res.status,
      headers: res.headers,
      text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer()),
    }),
  );

const brasiliaDay = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date)
    .slice(0, 10);

const testStep = (name, fn) =>
  test(name, { skip: SKIP }, async () => {
    assert.ok(fx.ready, 'a preparação (passos 1 a 5) falhou; veja o primeiro erro');

    await fn();
  });

// ---------- Passos 1 a 5 ----------

before(async () => {
  if (SKIP) {
    return;
  }

  adminCookie = await signIn(admin.email, admin.password);
  previous = await getSettings();
  // O caminho da IA exige o servidor falso no ar E o app subido com ele (compose.test.yml): o container do servidor
  // falso pode continuar de pé com o app já recriado sem a chave.
  fakeUp =
    previous.aiStatus === 'CONFIGURED' &&
    (await fetch(`${FAKE_URL}/__health`)
      .then((res) => res.ok)
      .catch(() => false));

  // 1. Contas, prompt e e-mail da contabilidade.
  const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });

  assert.equal(imported.status, 200, imported.text);
  await saveSettings({ prompt: PROMPT, accountingEmail: ACCOUNTING });
  db(`delete from "RateLimit" where action like 'revalle.invoice%'`);

  fx.sender = await newAccount('remetente');
  fx.outsider = await newAccount('terceiro');
  fx.colleague = await newAccount('colega');

  const teamId = Number(
    db(
      `select t.id from "Team" t join "Organisation" o on o.id = t."organisationId" join "User" u on u.id = o."ownerUserId" where u.email = '${fx.sender.email}' limit 1`,
    ),
  );
  const token = await trpcAs(fx.sender.cookie, 'mutation', 'apiToken.create', {
    teamId,
    tokenName: `aceite-f5-${RUN}`,
    expirationDate: null,
  });

  assert.equal(token.status, 200, token.text);
  fx.senderToken = data(token).token;

  // 2. DANFE: a sugestão sai (servidor falso) e o remetente aceita. Sem IA, escolhe a mesma conta na lista.
  fx.danfe = await create({
    label: 'DANFE',
    pdf: await danfePdf(),
    signers: [fx.colleague.email, `f5-danfe-2-${RUN}@revalle.com.br`],
  });

  if (fakeUp) {
    await fake('/__program', { mode: 'ok', accountCode: '4.1.07' });

    const classified = await trpcAs(fx.sender.cookie, 'mutation', 'revalle.invoice.classify', {
      envelopeId: fx.danfe.id,
    });

    assert.equal(classified.status, 200, classified.text);

    const state = await waitSuggestion(fx.danfe.id);

    assert.equal(state.isInvoice, 'YES');
    assert.equal(state.suggestionStatus, 'DONE', JSON.stringify(state));
    assert.equal(state.suggestion.accountCode, '4.1.07');
    await setChoice(fx.danfe.id, { code: state.suggestion.accountCode });
  } else {
    await setChoice(fx.danfe.id, { code: '4.1.07' });
  }

  // 3. NFS-e: "Deixar para a contabilidade decidir", sem sugestão (o servidor falso responde erro).
  fx.nfse = await create({
    label: 'NFS-e',
    pdf: await nfsePdf(),
    signers: [`f5-nfse-1-${RUN}@revalle.com.br`, `f5-nfse-2-${RUN}@revalle.com.br`],
  });

  if (fakeUp) {
    await fake('/__program', { mode: 'error' });
  }

  await setChoice(fx.nfse.id, { defer: true });

  if (fakeUp) {
    assert.equal((await waitSuggestion(fx.nfse.id)).suggestionStatus, 'FAILED');
  }

  // 4. Contrato comum: enviado sem escolha nenhuma (fica pendente).
  fx.contract = await create({
    label: 'Contrato',
    pdf: 'assets/example.pdf',
    signers: [`f5-contrato-1-${RUN}@revalle.com.br`, `f5-contrato-2-${RUN}@revalle.com.br`],
  });
  await distribute(fx.contract.id, { apiToken: fx.senderToken });

  // 5. Dois signatários em cada NF.
  // A NFS-e (criada depois) é enviada ANTES do DANFE: a ordem por data de envio difere da ordem de criação.
  await signAll(fx.nfse);
  await signAll(fx.danfe);

  fx.ready = true;
});

after(async () => {
  if (SKIP || !adminCookie) {
    return;
  }

  try {
    if (fakeUp) {
      await fake('/__reset', {});
    }
  } finally {
    if (previous) {
      await saveSettings({ prompt: previous.prompt, accountingEmail: previous.accountingEmail ?? '' });
    }
  }
});

// ---------- Passos 6 a 10 ----------

testStep(
  '6. página: 2 NFs para o remetente, 0 para um terceiro, só a sua para o colega e as 2 para o admin',
  async () => {
    const mine = await find(fx.sender.cookie);

    assert.equal(mine.count, 2, JSON.stringify(mine));
    // Mais recente primeiro pela data de ENVIO (o DANFE foi enviado depois, embora criado antes).
    assert.deepEqual(
      mine.data.map((row) => row.id),
      [fx.danfe.id, fx.nfse.id],
    );
    assert.ok(mine.data.every((row) => row.deleted === false));

    const danfe = mine.data.find((row) => row.id === fx.danfe.id);
    const nfse = mine.data.find((row) => row.id === fx.nfse.id);

    assert.equal(danfe.title, fx.danfe.title);
    assert.equal(danfe.status, 'COMPLETED');
    assert.equal(danfe.senderName, fx.sender.name);
    assert.ok(danfe.sentAt && danfe.completedAt, JSON.stringify(danfe));
    assert.deepEqual(danfe.account, { code: '4.1.07', name: 'Fornecedores Aceite Cinco' });
    assert.equal(danfe.deferred, false);
    assert.equal(danfe.acceptedSuggestion, fakeUp ? true : null);
    assert.match(danfe.link, new RegExp(`^/t/[^/]+/documents/${fx.danfe.id}$`));
    assert.equal(nfse.account, null);
    assert.equal(nfse.deferred, true);
    assert.equal(nfse.acceptedSuggestion, null);

    const outsider = await find(fx.outsider.cookie);

    assert.equal(outsider.count, 0);
    assert.deepEqual(outsider.data, []);

    // Signatário de uma NF (pelo e-mail): vê só essa, sem link de editor.
    const colleague = await find(fx.colleague.cookie);

    assert.deepEqual(
      colleague.data.map((row) => row.id),
      [fx.danfe.id],
    );
    assert.equal(colleague.data[0].link, null);

    const all = await find(adminCookie);
    const adminIds = all.data.map((row) => row.id);

    assert.ok(all.count >= 2);
    assert.ok(adminIds.includes(fx.danfe.id) && adminIds.includes(fx.nfse.id), 'o admin não vê as NFs do remetente');
    assert.ok(!adminIds.includes(fx.contract.id), 'contrato comum não é nota fiscal');
    assert.equal(all.data.find((row) => row.id === fx.danfe.id).link, `/admin/documents/${fx.danfe.id}`);

    // Filtros.
    const ids = async (input) => (await find(fx.sender.cookie, input)).data.map((row) => row.id);
    const today = brasiliaDay();
    const tomorrow = brasiliaDay(new Date(Date.now() + 24 * 3600 * 1000));

    assert.deepEqual(await ids({ deferred: true }), [fx.nfse.id]);
    assert.deepEqual(await ids({ accountCode: '4.1.07' }), [fx.danfe.id]);
    assert.deepEqual(await ids({ accountCode: '4.2.19' }), []);
    assert.equal((await ids({ status: 'COMPLETED' })).length, 2);
    assert.deepEqual(await ids({ status: 'PENDING' }), []);
    assert.equal((await ids({ from: today, to: today })).length, 2);
    assert.deepEqual(await ids({ from: tomorrow }), []);

    // A página em si: abre com sessão; sem sessão vai para o login.
    const page = await fetchIdempotent(`${BASE_URL}/notas-fiscais`, { headers: { Cookie: fx.sender.cookie } }, (r) =>
      r.text().then((text) => ({ status: r.status, text })),
    );

    assert.equal(page.status, 200);
    assert.ok(page.text.includes('Notas fiscais'), 'título da página ausente');

    const anonymous = await fetchIdempotent(`${BASE_URL}/notas-fiscais`, { redirect: 'manual' }, (r) => ({
      status: r.status,
      location: r.headers.get('location') ?? '',
    }));

    assert.ok(anonymous.status >= 300 && anonymous.status < 400, `sem sessão: HTTP ${anonymous.status}`);
    assert.match(anonymous.location, /\/signin/);
  },
);

testStep('7. planilha: BOM, cabeçalho exato, 2 linhas com as contas certas, filtros e acesso', async () => {
  const res = await csv(fx.sender.cookie);

  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="notas-fiscais-${brasiliaDay()}.csv"`);
  assert.ok(res.text.startsWith('﻿'), 'sem BOM');

  const lines = res.text.slice(1).split('\r\n').filter(Boolean);

  // Mesma ordem da tela: data de envio, mais recente primeiro.
  assert.deepEqual(
    lines.slice(1).map((line) => line.split(';')[0]),
    [fx.danfe.id, fx.nfse.id],
  );

  assert.equal(lines[0], HEADER);
  assert.equal(lines.length, 3, res.text);

  const cells = (id) => {
    const line = lines.find((l) => l.startsWith(`${id};`));

    assert.ok(line, `linha de ${id} ausente`);

    return Object.fromEntries(HEADER.split(';').map((name, index) => [name, line.split(';')[index]]));
  };

  const danfe = cells(fx.danfe.id);

  assert.equal(danfe.titulo, fx.danfe.title);
  assert.equal(danfe.remetente, fx.sender.name);
  assert.equal(danfe.status, 'Concluído');
  assert.match(danfe.enviado_em, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  assert.match(danfe.concluido_em, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  assert.equal(danfe.conta, '4.1.07');
  assert.equal(danfe.nome_conta, 'Fornecedores Aceite Cinco');
  assert.equal(danfe.tipo, 'pagar');
  assert.equal(danfe.sugestao_ia, fakeUp ? '4.1.07' : '');
  assert.equal(danfe.confianca, fakeUp ? 'alta' : '');
  assert.equal(danfe.aceitou_sugestao, fakeUp ? 'sim' : '');
  assert.match(danfe.link, new RegExp(`^https?://[^/]+/t/[^/]+/documents/${fx.danfe.id}$`));

  const nfse = cells(fx.nfse.id);

  assert.equal(nfse.conta, 'a definir pela contabilidade');
  assert.equal(nfse.nome_conta, '');
  assert.equal(nfse.tipo, '');
  assert.equal(nfse.sugestao_ia, '');
  assert.equal(nfse.confianca, '');
  assert.equal(nfse.aceitou_sugestao, '');

  // A planilha segue os filtros da tela.
  const deferred = await csv(fx.sender.cookie, '?deixadas=1');

  assert.equal(deferred.status, 200);
  assert.deepEqual(
    deferred.text
      .slice(1)
      .split('\r\n')
      .filter(Boolean)
      .slice(1)
      .map((l) => l.split(';')[0]),
    [fx.nfse.id],
  );

  const byAccount = await csv(fx.sender.cookie, '?conta=4.1.07&status=COMPLETED');

  assert.deepEqual(
    byAccount.text
      .slice(1)
      .split('\r\n')
      .filter(Boolean)
      .slice(1)
      .map((l) => l.split(';')[0]),
    [fx.danfe.id],
  );

  // Terceiro: só o cabeçalho. Sem sessão: nada.
  const outsider = await csv(fx.outsider.cookie);

  assert.equal(outsider.status, 200);
  assert.deepEqual(outsider.text.slice(1).split('\r\n').filter(Boolean), [HEADER]);

  const anonymous = await csv(undefined);

  assert.ok([302, 401].includes(anonymous.status), `sem sessão: HTTP ${anonymous.status}`);
  assert.ok(!anonymous.text.includes(fx.danfe.id));

  // Filtro inválido: 400, sem planilha.
  assert.equal((await csv(fx.sender.cookie, '?de=ontem')).status, 400);

  // Data inicial depois da final: 400 com a mesma frase da tela.
  const reversed = await csv(fx.sender.cookie, '?de=2026-10-31&ate=2026-10-30');

  assert.equal(reversed.status, 400);
  assert.equal(reversed.text, 'A data inicial é depois da data final.');
});

testStep('8. a contabilidade recebeu 2 e-mails (um por NF)', async () => {
  const mails = await waitMails(ACCOUNTING, 2);

  assert.equal(mails.length, 2, JSON.stringify(mails.map((m) => m.Subject)));

  const subjects = mails.map((m) => m.Subject).sort();

  assert.deepEqual(
    subjects,
    [
      `Nota fiscal assinada: ${fx.danfe.title} · Conta 4.1.07 – Fornecedores Aceite Cinco`,
      `Nota fiscal assinada: ${fx.nfse.title} · Conta: a definir pela contabilidade`,
    ].sort(),
  );

  // Nada para o contrato comum.
  await sleep(2000);
  assert.equal((await emailsTo(ACCOUNTING)).length, 2);
});

testStep('9. a política de privacidade tem a frase do Gemini (spec §9) e a do CPF, exata', async () => {
  const html = await fetchIdempotent(`${BASE_URL}/privacidade`, {}, (res) => res.text());
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

  assert.ok(text.includes(PRIVACY_SENTENCE), 'frase da spec §9 ausente');
  assert.ok(text.includes(PRIVACY_CPF_SENTENCE), 'frase do CPF (texto mascarado, imagem como está) ausente');
  // A promessa antiga ("nunca enviamos o CPF") não vale para a NF digitalizada.
  assert.ok(!/Nunca enviamos o CPF/i.test(text), 'a política ainda promete nunca enviar o CPF');
});

testStep('10. o PDF selado (com certificado e log) não tem o número nem o nome da conta', async () => {
  for (const doc of [fx.danfe, fx.nfse]) {
    const dir = mkdtempSync(path.join(tmp, 'selado-'));

    writeFileSync(
      path.join(dir, 'signed.pdf'),
      await downloadItem(doc.item.id, 'signed', { apiToken: fx.senderToken }),
    );

    const pages = Number(poppler(dir, 'pdfinfo /pdf/signed.pdf').match(/Pages:\s+(\d+)/)?.[1]);
    const text = poppler(dir, 'pdftotext -layout /pdf/signed.pdf -').replace(/\s+/g, ' ');

    // O certificado e o log de auditoria vão anexados ao PDF selado: a conferência abaixo vale para os três.
    assert.ok(pages > 1, `${doc.title}: ${pages} página(s)`);
    assert.ok(text.includes('Certificado de Assinatura'), `${doc.title}: sem o certificado`);
    assert.ok(text.includes('Log de Auditoria'), `${doc.title}: sem o log de auditoria`);
    assert.ok(text.includes(doc.id), `${doc.title}: o certificado não é deste documento`);

    for (const account of ACCOUNTS) {
      assert.ok(!text.includes(account.code), `${doc.title}: o PDF tem o número ${account.code}`);
      assert.ok(!text.includes(account.name), `${doc.title}: o PDF tem o nome ${account.name}`);
    }

    assert.ok(!text.includes('a definir pela contabilidade'), `${doc.title}: o PDF fala da contabilidade`);
    assert.ok(!/conta cont[aá]bil/i.test(text), `${doc.title}: o PDF fala de conta contábil`);
  }
});

testStep(
  '11. NF excluída pelo remetente: some para ele e continua para o admin, marcada na tela e na planilha',
  async () => {
    const deleted = await api('POST', '/envelope/delete', { envelopeId: fx.nfse.id }, { apiToken: fx.senderToken });

    assert.equal(deleted.status, 200, deleted.text);
    assert.notEqual(db(`select "deletedAt" from "Envelope" where id = '${fx.nfse.id}'`), '', 'não foi exclusão suave');

    // Dono: a NF sumiu da tela e da planilha.
    assert.deepEqual(
      (await find(fx.sender.cookie)).data.map((row) => row.id),
      [fx.danfe.id],
    );
    assert.ok(!(await csv(fx.sender.cookie)).text.includes(fx.nfse.id));

    // Admin: continua vendo, com a marca e o link do painel.
    const row = (await find(adminCookie, { deferred: true })).data.find((r) => r.id === fx.nfse.id);

    assert.ok(row, 'o admin não vê a NF excluída');
    assert.equal(row.deleted, true);
    assert.equal(row.link, `/admin/documents/${fx.nfse.id}`);
    assert.equal(
      (await find(adminCookie, { deferred: true })).data.find((r) => r.id === fx.danfe.id),
      undefined,
    );

    const exported = await csv(adminCookie, '?deixadas=1');
    const line = exported.text
      .slice(1)
      .split('\r\n')
      .find((l) => l.startsWith(`${fx.nfse.id};`));

    assert.equal(exported.status, 200);
    assert.ok(line, 'linha da NF excluída ausente na planilha do admin');
    assert.equal(line.split(';')[HEADER.split(';').indexOf('status')], 'excluído pelo remetente');
    assert.equal(exported.text.slice(1).split('\r\n')[0], HEADER);
  },
);
