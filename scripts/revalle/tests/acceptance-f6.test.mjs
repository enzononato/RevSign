// Aceite da Fase 6 (aprovação do Financeiro para notas fiscais; spec §8, itens 1 a 7, com as telas da Task 6). Roda
// contra a stack local, de ponta a ponta, na ordem da spec:
//   1. o admin marca um membro do Financeiro (conta nova, criada pelo teste);
//   2. NF com 2 signatários: os dois assinam, a NF fica retida e o membro recebe o e-mail com o link da página da NF
//      (só leitura); a página abre para o membro e para o dono, e dá 404 para quem não é do Financeiro nem está na NF;
//   3. o membro aprova: a NF é selada, o certificado traz a conta e a aprovação, a contabilidade recebe o e-mail; uma NF
//      marcada depois da conclusão aparece em "Aguardando o Financeiro" e também é aprovada;
//   4. outra NF: o membro troca a conta com motivo no meio das assinaturas; o link antigo é bloqueado, todos recebem o
//      aviso com o motivo (o remetente com o link da página da nova versão, quem assina com o próprio link de
//      assinatura dela), a v2 é enviada, assinada e selada com a conta nova; a página de cada versão aponta para a
//      outra; a contabilidade recebe a v2 com "Conta alterada pelo Financeiro ({membro}) — motivo: {motivo}";
//   5. "Deixar para o Financeiro": nada sai até o membro definir a conta (e-mail com o link da página da NF); depois, o
//      convite sai; assinada, a contabilidade recebe "Conta definida pelo Financeiro ({membro})";
//   6. quem não é do Financeiro recebe 403 nas rotas (e nada muda);
//   7. NF de antes da Fase 6 (`LEGACY`) conclui sem aprovação;
//   8. troca de conta numa NF já concluída e já enviada à contabilidade: o e-mail da v2 diz "Substitui o envio da versão
//      anterior: {título}";
//   e a lista "Notas fiscais" (colunas novas, filtro do Financeiro, rascunhos retidos, versões substituídas) e a
//   planilha com `financeiro;aprovado_por` no fim do cabeçalho.
//
// Sessões: REVSIGN_ADMIN_* (rsadmin, ADMIN, marca o membro) e REVSIGN_USER_* (admin@hml.local, dono do
// REVSIGN_API_TOKEN, remetente, fora do Financeiro). O membro e o terceiro são contas novas a cada execução; o membro
// é desmarcado no fim. O e-mail da contabilidade anterior é restaurado no fim. Ver revalle/docs/testes.md.

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

const MAILPIT = 'http://localhost:8025/api/v1';
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };
const SKIP =
  !user.email || !user.password || !admin.email || !admin.password
    ? 'defina REVSIGN_USER_* e REVSIGN_ADMIN_* (ver revalle/docs/testes.md)'
    : false;

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = `Aceite-F6-${RUN}!`;
const ACCOUNTING = `contabilidade-f6-${RUN}@revalle.com.br`;
const REASON = 'Era serviço tomado, não compra de mercadoria.';
const origin = new URL(BASE_URL).origin;

// Números e nomes que não aparecem por acaso num PDF, para as conferências do certificado valerem nos dois sentidos.
const OLD = { code: '7.6.01', name: 'Fornecedores Aceite Seis' };
const NEW = { code: '7.6.02', name: 'Serviços Tomados Aceite Seis' };
const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  `${OLD.code};${OLD.name};Conta do aceite da Fase 6;pagar`,
  `${NEW.code};${NEW.name};Conta do aceite da Fase 6;pagar`,
].join('\n');

// Textos exatos (spec e global-constraints).
const HEADER =
  'id;titulo;remetente;enviado_em;concluido_em;status;conta;nome_conta;tipo;sugestao_ia;confianca;aceitou_sugestao;link;financeiro;aprovado_por';
const APPROVAL_SUBJECT = (title) => `Nota fiscal aguardando aprovação do Financeiro: ${title}`;
const AWAITING_SUBJECT = (title) => `Nota fiscal aguardando o Financeiro: ${title}`;
const NOTICE_SUBJECT = (title) => `Conta contábil da nota fiscal alterada pelo Financeiro: ${title}`;
const NOTICE = (title) =>
  `A conta contábil da nota fiscal ${title} foi alterada pelo Financeiro de ${OLD.code} – ${OLD.name} para ${NEW.code} – ${NEW.name}. Motivo: ${REASON}`;
const ACCOUNTING_SUBJECT = (title, account) =>
  `Nota fiscal assinada: ${title} · Conta ${account.code} – ${account.name}`;
const GATE_MESSAGE = 'Este documento foi substituído por uma nova versão (conta contábil alterada).';
const DOCUMENT_LINE = (account, approver, at) =>
  `Conta contábil: ${account.code} – ${account.name} · aprovada pelo Financeiro (${approver}) em ${at} (horário de Brasília)`;
const SIGNER_ROW = (code) => `Conta contábil vista ao assinar: ${code}`;
const DEFINED_LINE = (name) => `Conta definida pelo Financeiro (${name})`;
const CHANGED_LINE = (name) => `Conta alterada pelo Financeiro (${name}) — motivo: ${REASON}`;
const REPLACES_LINE = (title) => `Substitui o envio da versão anterior: ${title}`;

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-aceite-f6-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fx = {};
let userCookie;
let adminCookie;
let senderName;
let previousAccountingEmail;

const data = (res) => res.body?.result?.data?.json;
const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);
const financeStatus = (envelopeId) =>
  db(
    `select coalesce("financeStatus"::text, '-') from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );
const brasiliaColumn = (column, envelopeId) =>
  db(
    `select to_char(("${column}" at time zone 'UTC') at time zone 'America/Bahia', 'DD/MM/YYYY HH24:MI') from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia' }).format(new Date());

const waitStatus = async (envelopeId, wanted, attempts = 45) => {
  for (let i = 0; i < attempts && status(envelopeId) !== wanted; i += 1) {
    await sleep(2000);
  }

  return status(envelopeId);
};

// ---------- Mailpit ----------

const mailsTo = async (to) =>
  (await fetchIdempotent(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`, {}, (res) => res.json()))
    .messages ?? [];
const mailBody = (id) => fetchIdempotent(`${MAILPIT}/message/${id}`, {}, (res) => res.json());
const flat = (text) => (text ?? '').replace(/\s+/g, ' ');

const waitMails = async (to, filter, timeoutMs = 40_000) => {
  const deadline = Date.now() + timeoutMs;

  do {
    const found = (await mailsTo(to)).filter(filter);

    if (found.length > 0) {
      return found;
    }

    await sleep(500);
  } while (Date.now() < deadline);

  return [];
};

const waitInvite = async (email, token, timeoutMs = 40_000) => {
  const deadline = Date.now() + timeoutMs;

  do {
    for (const mail of await mailsTo(email)) {
      // O aviso da troca também leva o link de assinatura, mas não é o convite.
      if (!mail.Subject.startsWith(NOTICE_SUBJECT('')) && (await mailBody(mail.ID)).Text?.includes(`/sign/${token}`)) {
        return true;
      }
    }

    await sleep(1000);
  } while (Date.now() < deadline);

  return false;
};

// ---------- Contas novas (cadastro, confirmação pelo link do Mailpit e login) ----------

const newAccount = async (label) => {
  const email = `f6-aceite-${label}-${RUN}@revalle.com.br`;
  const name = `Aceite F6 ${label}`;
  const created = await fetch(`${BASE_URL}/api/auth/email-password/signup`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Forwarded-For': `203.0.113.${Math.floor(Math.random() * 250) + 1}`,
    },
    body: JSON.stringify({ name, email, password: PASSWORD }),
  });

  assert.ok(created.ok, `cadastro de ${label} falhou (${created.status}): ${await created.text()}`);

  const [message] = await waitMails(email, () => true);

  assert.ok(message, `e-mail de confirmação de ${label} não chegou`);

  const token = ((await mailBody(message.ID)).HTML ?? '').match(/\/verify-email\/([A-Za-z0-9_-]+)/)?.[1];

  assert.ok(token, `link de confirmação ausente para ${label}`);

  const verified = await fetch(`${BASE_URL}/api/auth/email-password/verify-email`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  assert.equal(verified.status, 200, await verified.text());

  return {
    email,
    name,
    id: Number(db(`select id from "User" where email = '${email}'`)),
    cookie: await signIn(email, PASSWORD),
  };
};

// ---------- Documentos ----------

const danfe = async (variant) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const lines = [
    'DANFE - Documento Auxiliar da Nota Fiscal Eletrônica',
    'Nº 000.012.345   Série 001',
    'Chave de Acesso',
    '2924 1012 3456 7800 0195 5500 1000 0123 4511 2345 6784',
    'Natureza da Operação: Venda de mercadoria adquirida de terceiros',
    'Emitente: Distribuidora Fictícia de Ferragens Ltda   CNPJ 12.345.678/0001-95',
    `Referência do teste: aceite F6 ${variant} ${RUN}`,
    'Valor Total da Nota: R$ 150,00',
  ];
  let y = 800;

  for (const line of lines) {
    page.drawText(line, { x: 40, y, size: 10, font, color: rgb(0, 0, 0) });
    y -= 16;
  }

  const file = path.join(tmp, `danfe-${variant}.pdf`);

  writeFileSync(file, Buffer.from(await doc.save()));

  return file;
};

// Lê uma versão do banco: destinatários (com token), o campo de assinatura de cada um e o 1º arquivo.
const loadVersion = (envelopeId) => {
  const [secondaryId, title] = db(`select "secondaryId" || '|' || title from "Envelope" where id = '${envelopeId}'`)
    .split(/\|(.*)/s)
    .slice(0, 2);
  const recipients = db(
    `select r.id || '|' || r.token || '|' || r.email || '|' || coalesce((select f.id::text from "Field" f where f."recipientId" = r.id and f.type = 'SIGNATURE' limit 1), '-') from "Recipient" r where r."envelopeId" = '${envelopeId}' order by r.email`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, token, email, fieldId] = line.split('|');

      return { id: Number(id), token, email, fieldId: Number(fieldId) };
    });

  return {
    id: envelopeId,
    title,
    documentId: Number.parseInt(secondaryId.split('_')[1], 10),
    item: db(`select id from "EnvelopeItem" where "envelopeId" = '${envelopeId}' order by "order" limit 1`),
    recipients,
  };
};

// NF do remetente (REVSIGN_USER_*), com convites por e-mail; `choice` = conta ou "Deixar para o Financeiro".
const newInvoice = async (label, { signers = 2, choice = { code: OLD.code }, send = true } = {}) => {
  const emails = Array.from({ length: signers }, (_, index) => `f6-aceite-${label}-${index + 1}-${RUN}@revalle.com.br`);
  const title = `[TESTE F6] ${label} ${RUN}`;
  const pdf = await danfe(label);
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({
      title,
      pdf,
      meta: { distributionMethod: 'EMAIL' },
      recipients: emails.map((email, index) => ({
        email,
        name: `Signatário ${index + 1}`,
        fields: [{ type: 'SIGNATURE', page: 1, positionX: 10, positionY: 60 + index * 12, width: 30, height: 8 }],
      })),
    }),
  );

  assert.equal(created.status, 200, created.text);

  // A tela classifica ao abrir o envio (o DANFE é reconhecido como NF).
  const state = await trpcAs(userCookie, 'query', 'revalle.invoice.get', { envelopeId: created.id });

  assert.equal(state.status, 200, state.text);
  assert.equal(data(state).isInvoice, 'YES');

  const chosen = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
    envelopeId: created.id,
    choice,
  });

  assert.equal(chosen.status, 200, chosen.text);

  if (!send) {
    return loadVersion(created.id);
  }

  assert.equal((await distribute(created.id)).length, signers);

  const doc = loadVersion(created.id);

  // O convite chega por um job: esperar por ele antes de assinar, para ele não chegar depois do código por e-mail (o
  // código é lido do e-mail mais recente).
  for (const recipient of doc.recipients) {
    assert.ok(await waitInvite(recipient.email, recipient.token), `convite não chegou para ${recipient.email}`);
  }

  return doc;
};

const gate = async (token) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

// Portão, a página de assinatura (que mostra a conta), assinatura e conclusão com o código, como a tela faz.
const sign = async (doc, index) => {
  const recipient = doc.recipients[index];

  await gate(recipient.token);

  const page = await fetchIdempotent(`${BASE_URL}/sign/${recipient.token}`, {}, (r) => r.status);

  assert.equal(page, 200);

  const signed = await trpc('envelope.field.sign', {
    token: recipient.token,
    fieldId: recipient.fieldId,
    fieldValue: { type: 'SIGNATURE', value: 'Teste Digitado' },
  });

  assert.equal(signed.status, 200, signed.text);

  const completion = await completeWithCode({
    token: recipient.token,
    documentId: doc.documentId,
    email: recipient.email,
  });

  assert.ok(completion.ok, completion.text);
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
};

const sealedText = async (doc) => {
  const dir = mkdtempSync(path.join(tmp, 'selado-'));

  writeFileSync(path.join(dir, 'signed.pdf'), await downloadItem(doc.item, 'signed'));

  return poppler(dir, 'pdftotext /pdf/signed.pdf -').replace(/\s+/g, ' ');
};

const finance = (cookie, kind, name, input) => trpcAs(cookie, kind, `revalle.finance.${name}`, input);

// ---------- Lista, planilha e página da NF ----------

// Procura a linha da NF na lista (todas as páginas, enviadas a partir de hoje, com os filtros dados).
const findRow = async (cookie, envelopeId, filters = {}) => {
  for (let page = 1; page <= 50; page += 1) {
    const res = await trpcAs(cookie, 'query', 'revalle.invoice.find', {
      from: today(),
      perPage: 100,
      page,
      ...filters,
    });

    assert.equal(res.status, 200, res.text);

    const body = data(res);
    const row = body.data.find((candidate) => candidate.id === envelopeId);

    if (row || page >= body.totalPages) {
      return row;
    }
  }

  return undefined;
};

const csvRows = async (cookie, query) => {
  const res = await fetchIdempotent(
    `${BASE_URL}/notas-fiscais/csv?de=${today()}${query ? `&${query}` : ''}`,
    { headers: { Cookie: cookie } },
    async (r) => ({
      status: r.status,
      text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer()),
    }),
  );

  assert.equal(res.status, 200, res.text);

  assert.ok(res.text.startsWith('\uFEFF'), 'planilha sem BOM');

  const lines = res.text.slice(1).split('\r\n').filter(Boolean);

  assert.equal(lines[0], HEADER);

  const names = HEADER.split(';');

  return new Map(
    lines.slice(1).map((line) => {
      const cells = line.split(';');

      return [cells[0], Object.fromEntries(names.map((name, index) => [name, cells[index]]))];
    }),
  );
};

const invoicePage = (cookie, envelopeId, suffix = '') =>
  fetchIdempotent(
    `${BASE_URL}/notas-fiscais/${envelopeId}${suffix}`,
    { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' },
    async (r) => ({ status: r.status, type: r.headers.get('content-type') ?? '', text: await r.text() }),
  );

const testStep = (name, fn) =>
  test(name, { skip: SKIP }, async () => {
    await fn();
  });

before(async () => {
  if (SKIP) {
    return;
  }

  userCookie = await signIn(user.email, user.password);
  adminCookie = await signIn(admin.email, admin.password);
  senderName = db(`select coalesce(nullif(trim(name), ''), email) from "User" where email = '${user.email}'`);

  const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });

  assert.equal(imported.status, 200, imported.text);

  const settings = await trpcAs(adminCookie, 'query', 'revalle.invoice.adminGetSettings', undefined);

  assert.equal(settings.status, 200, settings.text);
  previousAccountingEmail = data(settings);

  const saved = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminUpdateSettings', {
    prompt: previousAccountingEmail.prompt,
    accountingEmail: ACCOUNTING,
  });

  assert.equal(saved.status, 200, saved.text);

  // O remetente nunca é do Financeiro; o rsadmin é (regra dos testes da Fase 6).
  db(`delete from "RevalleFinanceMember" where "userId" = (select id from "User" where email = '${user.email}')`);
  db('delete from "RateLimit"');

  fx.fin = await newAccount('financeiro');
  fx.outsider = await newAccount('terceiro');
});

after(async () => {
  if (SKIP || !adminCookie) {
    return;
  }

  if (fx.fin) {
    await finance(adminCookie, 'mutation', 'adminSetMember', { userId: fx.fin.id, member: false });
  }

  if (previousAccountingEmail) {
    await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminUpdateSettings', {
      prompt: previousAccountingEmail.prompt,
      accountingEmail: previousAccountingEmail.accountingEmail ?? '',
    });
  }
});

// ---------- 1 a 7 ----------

testStep('1. o admin marca um membro do Financeiro', async () => {
  const marked = await finance(adminCookie, 'mutation', 'adminSetMember', { userId: fx.fin.id, member: true });

  assert.equal(marked.status, 200, marked.text);
  assert.equal(data(await finance(fx.fin.cookie, 'query', 'me', undefined)).isFinance, true);
  assert.equal(data(await finance(fx.outsider.cookie, 'query', 'me', undefined)).isFinance, false);
});

testStep(
  '2. NF com 2 signatários: todos assinam, fica retida, o Financeiro recebe o e-mail com o link da página da NF',
  async () => {
    fx.a = await newInvoice('aprovada');
    assert.equal(financeStatus(fx.a.id), 'PENDING_APPROVAL');

    await sign(fx.a, 0);
    await sign(fx.a, 1);
    await sleep(2000);

    assert.equal(status(fx.a.id), 'PENDING', 'a NF não ficou retida');
    assert.equal(financeStatus(fx.a.id), 'PENDING_APPROVAL');

    const [mail] = await waitMails(fx.fin.email, (m) => m.Subject === APPROVAL_SUBJECT(fx.a.title));

    assert.ok(mail, 'o e-mail "aguardando aprovação" não chegou ao membro');

    const body = await mailBody(mail.ID);

    assert.ok(flat(body.Text).includes(`${OLD.code} – ${OLD.name}`), 'e-mail sem a conta');
    assert.ok(body.Text.includes(`/notas-fiscais/${fx.a.id}`), `e-mail sem o link da página da NF: ${flat(body.Text)}`);

    // Lista do Financeiro: "Aguardando o Financeiro", com a situação, a versão e o link da página da NF.
    const row = await findRow(fx.fin.cookie, fx.a.id, { finance: 'pendentes' });

    assert.ok(row, 'a NF retida não está em "Aguardando o Financeiro"');
    assert.equal(row.financeStatus, 'PENDING_APPROVAL');
    assert.equal(row.version, 1);
    assert.equal(row.link, `/notas-fiscais/${fx.a.id}`);

    // Página da NF, só leitura: membro e dono abrem; terceiro, 404; sem sessão, vai para o login.
    const asMember = await invoicePage(fx.fin.cookie, fx.a.id);

    assert.equal(asMember.status, 200, asMember.text.slice(0, 300));
    assert.ok(asMember.text.includes(fx.a.title), 'a página da NF não mostra o título');
    assert.ok(asMember.text.includes(senderName), 'a página da NF não mostra o remetente');

    for (const recipient of fx.a.recipients) {
      assert.ok(asMember.text.includes(recipient.email), `a página da NF não mostra o signatário ${recipient.email}`);
    }

    assert.ok(asMember.text.includes('data-testid="invoice-view-page"'), 'sem a página da NF');

    const asOwner = await invoicePage(userCookie, fx.a.id);

    assert.equal(asOwner.status, 200);
    assert.ok(asOwner.text.includes(fx.a.title));

    const asOutsider = await invoicePage(fx.outsider.cookie, fx.a.id);

    assert.equal(asOutsider.status, 404, 'terceiro abriu a página da NF');
    assert.ok(!asOutsider.text.includes(fx.a.title), 'a página 404 mostra o título');

    const anonymous = await invoicePage(undefined, fx.a.id);

    assert.ok([302, 303, 401].includes(anonymous.status), `sem sessão: HTTP ${anonymous.status}`);
    assert.ok(!anonymous.text.includes(fx.a.title));

    // O PDF da prévia: membro lê; terceiro, 404.
    const pdf = await invoicePage(fx.fin.cookie, fx.a.id, `/pdf/${fx.a.item}`);

    assert.equal(pdf.status, 200);
    assert.equal(pdf.type, 'application/pdf');
    assert.equal((await invoicePage(fx.outsider.cookie, fx.a.id, `/pdf/${fx.a.item}`)).status, 404);

    // Admin → Documentos não selados: a NF retida aparece marcada (esperando o Financeiro, não travada).
    const unsealed = await trpcAs(adminCookie, 'query', 'admin.document.findUnsealed', { page: 1, perPage: 100 });

    assert.equal(unsealed.status, 200, unsealed.text);
    assert.equal(
      data(unsealed).data.find((row) => row.id === fx.a.id)?.revalleFinanceStatus,
      'PENDING_APPROVAL',
      'a NF retida não está marcada na tela de documentos não selados',
    );

    // Cartão do Financeiro: dados para o membro.
    const card = await finance(fx.fin.cookie, 'query', 'get', { envelopeId: fx.a.id });

    assert.equal(card.status, 200, card.text);
    assert.equal(data(card).financeStatus, 'PENDING_APPROVAL');
    assert.deepEqual(data(card).account, { code: OLD.code, name: OLD.name });
    assert.equal(data(card).choiceBy, senderName);
  },
);

testStep(
  '3. o Financeiro aprova: selada, certificado com a conta e a aprovação, e-mail da contabilidade; NF marcada depois da conclusão',
  async () => {
    const approved = await finance(fx.fin.cookie, 'mutation', 'approve', { envelopeId: fx.a.id });

    assert.equal(approved.status, 200, approved.text);
    assert.equal(data(approved).approved, true);
    assert.equal(await waitStatus(fx.a.id, 'COMPLETED'), 'COMPLETED');
    assert.equal(financeStatus(fx.a.id), 'APPROVED');

    const at = brasiliaColumn('approvedAt', fx.a.id);
    const text = await sealedText(fx.a);

    assert.ok(text.includes(DOCUMENT_LINE(OLD, fx.fin.name, at)), 'certificado sem a linha da conta e da aprovação');
    assert.equal(text.split(SIGNER_ROW(OLD.code)).length - 1, 2, 'uma linha "vista ao assinar" por signatário');

    const [accounting] = await waitMails(ACCOUNTING, (m) => m.Subject === ACCOUNTING_SUBJECT(fx.a.title, OLD));

    assert.ok(accounting, 'a contabilidade não recebeu o e-mail da NF aprovada');

    // Saiu de "Aguardando o Financeiro"; a situação na lista é "aprovada".
    assert.equal(await findRow(fx.fin.cookie, fx.a.id, { finance: 'pendentes' }), undefined);

    const row = await findRow(fx.fin.cookie, fx.a.id, { finance: 'aprovadas' });

    assert.equal(row?.financeStatus, 'APPROVED');
    assert.equal(row.approvedBy, fx.fin.name);

    // Documento comum concluído e marcado como NF depois: aguarda o Financeiro na lista; aprovado, vai à contabilidade.
    const created = await retryCreateOnStaleSocket(() =>
      createEnvelope({
        title: `[TESTE F6] marcada depois ${RUN}`,
        recipients: [{ email: `f6-aceite-marcada-1-${RUN}@revalle.com.br` }],
      }),
    );

    assert.equal(created.status, 200, created.text);
    await distribute(created.id);
    fx.e = loadVersion(created.id);
    await sign(fx.e, 0);
    assert.equal(await waitStatus(fx.e.id, 'COMPLETED'), 'COMPLETED');

    const marked = await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: fx.e.id });

    assert.equal(marked.status, 200, marked.text);

    const chosen = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
      envelopeId: fx.e.id,
      choice: { code: OLD.code },
    });

    assert.equal(chosen.status, 200, chosen.text);
    assert.equal(financeStatus(fx.e.id), 'PENDING_APPROVAL');

    const pending = await findRow(fx.fin.cookie, fx.e.id, { finance: 'pendentes' });

    assert.equal(
      pending?.status,
      'COMPLETED',
      'a NF marcada depois da conclusão não está em "Aguardando o Financeiro"',
    );
    assert.equal(pending.financeStatus, 'PENDING_APPROVAL');

    const approvedLate = await finance(fx.fin.cookie, 'mutation', 'approve', { envelopeId: fx.e.id });

    assert.equal(approvedLate.status, 200, approvedLate.text);

    const [late] = await waitMails(ACCOUNTING, (m) => m.Subject === ACCOUNTING_SUBJECT(fx.e.title, OLD));

    assert.ok(late, 'a contabilidade não recebeu o e-mail da NF marcada depois');
  },
);

testStep(
  '4. troca de conta no meio: link antigo bloqueado, aviso com o motivo para todos, v2 enviada, assinada e selada com a conta nova',
  async () => {
    fx.b = await newInvoice('trocada');

    await sign(fx.b, 0);

    const changed = await finance(fx.fin.cookie, 'mutation', 'changeAccount', {
      envelopeId: fx.b.id,
      code: NEW.code,
      reason: REASON,
    });

    assert.equal(changed.status, 200, changed.text);
    fx.b2 = loadVersion(data(changed).newEnvelopeId);

    assert.equal(financeStatus(fx.b.id), 'SUPERSEDED');
    assert.equal(fx.b2.title, `${fx.b.title} (v2)`);

    // O link antigo do 2º signatário mostra a mensagem do portão.
    const oldPage = await fetchIdempotent(`${BASE_URL}/sign/${fx.b.recipients[1].token}`, {}, (r) => r.text());

    assert.ok(oldPage.includes(GATE_MESSAGE), 'o link antigo não foi bloqueado');

    // Aviso exato com o motivo para o remetente (link da página da nova versão: ele tem conta) e os 2 signatários (o
    // próprio link de assinatura da nova versão: eles não têm conta no RevSign).
    const targets = [
      [user.email, `/notas-fiscais/${fx.b2.id}`],
      ...fx.b2.recipients.map((recipient) => [recipient.email, `/sign/${recipient.token}`]),
    ];

    for (const [to, link] of targets) {
      const notices = await waitMails(to, (m) => m.Subject === NOTICE_SUBJECT(fx.b.title));

      assert.equal(notices.length, 1, `aviso para ${to}`);

      const body = await mailBody(notices[0].ID);

      assert.ok(flat(body.Text).includes(NOTICE(fx.b.title)), flat(body.Text));
      assert.ok(body.Text.includes(link), `aviso sem o link ${link} (${to})`);
    }

    for (const recipient of fx.b2.recipients) {
      assert.ok(await waitInvite(recipient.email, recipient.token), `convite da v2 não chegou para ${recipient.email}`);
    }

    // As duas versões na lista do dono (a antiga, escondida das listas do upstream, aparece como substituída).
    const oldRow = await findRow(userCookie, fx.b.id);

    assert.equal(oldRow?.financeStatus, 'SUPERSEDED', 'a versão substituída sumiu da lista do dono');
    assert.equal(oldRow.version, 1);
    assert.equal(oldRow.deleted, false);

    const newRow = await findRow(userCookie, fx.b2.id);

    assert.equal(newRow?.financeStatus, 'APPROVED');
    assert.equal(newRow.version, 2);

    // A página de cada versão aponta para a outra.
    const oldView = await invoicePage(fx.fin.cookie, fx.b.id);

    assert.equal(oldView.status, 200);
    assert.ok(oldView.text.includes(`/notas-fiscais/${fx.b2.id}`), 'a versão antiga não aponta para a nova');
    assert.ok(oldView.text.includes(REASON), 'a versão antiga não mostra o motivo');

    const newView = await invoicePage(userCookie, fx.b2.id);

    assert.equal(newView.status, 200);
    assert.ok(newView.text.includes(`/notas-fiscais/${fx.b.id}`), 'a nova versão não aponta para a anterior');

    // A v2 é assinada e selada (a conta nova já vale como aprovada) com a conta nova no certificado.
    await sign(fx.b2, 0);
    await sign(fx.b2, 1);
    assert.equal(await waitStatus(fx.b2.id, 'COMPLETED'), 'COMPLETED');

    const text = await sealedText(fx.b2);

    assert.ok(
      text.includes(DOCUMENT_LINE(NEW, fx.fin.name, brasiliaColumn('approvedAt', fx.b2.id))),
      'certificado da v2 sem a conta nova aprovada',
    );
    assert.equal(text.split(SIGNER_ROW(NEW.code)).length - 1, 2);
    // A conta antiga só aparece no log (o evento da troca liga as versões), nunca como conta vista ou aprovada.
    assert.equal(text.split(SIGNER_ROW(OLD.code)).length - 1, 0, 'a conta antiga aparece como vista ao assinar na v2');
    assert.ok(!text.includes(`Conta contábil: ${OLD.code} – ${OLD.name} · aprovada`), 'a v2 aprova a conta antiga');
    assert.equal(status(fx.b.id), 'PENDING', 'a versão antiga foi concluída');

    // A contabilidade recebe a v2 dizendo que o Financeiro alterou a conta (e o motivo). A v1 nunca foi para a
    // contabilidade (estava pendente): nada a substituir.
    const [accounting] = await waitMails(ACCOUNTING, (m) => m.Subject === ACCOUNTING_SUBJECT(fx.b2.title, NEW));

    assert.ok(accounting, 'a contabilidade não recebeu o e-mail da v2');

    const accountingText = flat((await mailBody(accounting.ID)).Text);

    assert.ok(accountingText.includes(CHANGED_LINE(fx.fin.name)), accountingText);
    assert.ok(!accountingText.includes('escolhida pelo remetente'), accountingText);
    assert.ok(!accountingText.includes('aceita pelo remetente'), accountingText);
    assert.ok(!accountingText.includes('Substitui o envio'), accountingText);
  },
);

testStep('5. "Deixar para o Financeiro": nada sai até a conta ser definida', async () => {
  fx.c = await newInvoice('deixada', { signers: 1, choice: { defer: true }, send: false });

  const held = await api('POST', '/envelope/distribute', { envelopeId: fx.c.id });

  assert.equal(held.status, 409, held.text);
  assert.equal(status(fx.c.id), 'DRAFT');
  assert.equal(financeStatus(fx.c.id), 'AWAITING_ACCOUNT');

  const [mail] = await waitMails(fx.fin.email, (m) => m.Subject === AWAITING_SUBJECT(fx.c.title));

  assert.ok(mail, 'o e-mail "aguardando o Financeiro" não chegou ao membro');
  assert.ok((await mailBody(mail.ID)).Text.includes(`/notas-fiscais/${fx.c.id}`), 'e-mail sem o link da página da NF');

  await sleep(2000);
  assert.deepEqual(await mailsTo(fx.c.recipients[0].email), [], 'saiu e-mail para o signatário antes da conta');

  // O rascunho retido aparece para o membro ("Aguardando o Financeiro") e para o dono; não para o terceiro.
  const row = await findRow(fx.fin.cookie, fx.c.id, { finance: 'pendentes' });

  assert.equal(row?.status, 'DRAFT', 'o rascunho retido não aparece para o Financeiro');
  assert.equal(row.financeStatus, 'AWAITING_ACCOUNT');
  assert.equal(row.sentAt, null);
  assert.equal((await findRow(userCookie, fx.c.id))?.financeStatus, 'AWAITING_ACCOUNT');
  assert.equal(await findRow(fx.outsider.cookie, fx.c.id), undefined);
  assert.equal((await invoicePage(fx.fin.cookie, fx.c.id)).status, 200);

  const defined = await finance(fx.fin.cookie, 'mutation', 'defineAccount', { envelopeId: fx.c.id, code: OLD.code });

  assert.equal(defined.status, 200, defined.text);
  assert.equal(data(defined).sent, true);
  assert.equal(status(fx.c.id), 'PENDING');
  assert.equal(financeStatus(fx.c.id), 'APPROVED');

  const signer = loadVersion(fx.c.id).recipients[0];

  assert.ok(await waitInvite(signer.email, signer.token), 'o convite não saiu depois da conta definida');

  // Assinada, a contabilidade recebe a NF dizendo que a conta foi definida pelo Financeiro (não pelo remetente).
  await sign(loadVersion(fx.c.id), 0);
  assert.equal(await waitStatus(fx.c.id, 'COMPLETED'), 'COMPLETED');

  const [accounting] = await waitMails(ACCOUNTING, (m) => m.Subject === ACCOUNTING_SUBJECT(fx.c.title, OLD));

  assert.ok(accounting, 'a contabilidade não recebeu a NF definida pelo Financeiro');

  const accountingText = flat((await mailBody(accounting.ID)).Text);

  assert.ok(accountingText.includes(DEFINED_LINE(fx.fin.name)), accountingText);
  assert.ok(!accountingText.includes('pelo remetente'), accountingText);
});

testStep('6. quem não é do Financeiro recebe 403 nas rotas, e nada muda', async () => {
  const pending = await newInvoice('sem-perfil', { signers: 1 });

  for (const cookie of [fx.outsider.cookie, userCookie]) {
    for (const [name, input] of [
      ['approve', { envelopeId: pending.id }],
      ['changeAccount', { envelopeId: pending.id, code: NEW.code, reason: REASON }],
      ['defineAccount', { envelopeId: pending.id, code: NEW.code }],
    ]) {
      const res = await finance(cookie, 'mutation', name, input);

      assert.equal(res.status, 403, `${name}: ${res.text}`);
    }

    assert.equal((await finance(cookie, 'query', 'get', { envelopeId: pending.id })).status, 403);
  }

  assert.equal(financeStatus(pending.id), 'PENDING_APPROVAL');
  assert.equal(
    db(`select count(*) from "RevalleInvoiceClassification" where "previousEnvelopeId" = '${pending.id}'`),
    '0',
  );
  assert.equal((await invoicePage(fx.outsider.cookie, pending.id)).status, 404);
});

testStep('7. NF anterior à Fase 6 (LEGACY) conclui sem aprovação', async () => {
  fx.d = await newInvoice('legada', { signers: 1 });

  // NF já enviada antes da Fase 6 (a migração marca LEGACY).
  db(`update "RevalleInvoiceClassification" set "financeStatus" = 'LEGACY' where "envelopeId" = '${fx.d.id}'`);

  await sign(fx.d, 0);
  assert.equal(await waitStatus(fx.d.id, 'COMPLETED'), 'COMPLETED');
  assert.equal(financeStatus(fx.d.id), 'LEGACY');

  const [accounting] = await waitMails(ACCOUNTING, (m) => m.Subject === ACCOUNTING_SUBJECT(fx.d.title, OLD));

  assert.ok(accounting, 'a contabilidade não recebeu o e-mail da NF LEGACY');
  assert.deepEqual(
    (await mailsTo(fx.fin.email)).filter((m) => m.Subject === APPROVAL_SUBJECT(fx.d.title)),
    [],
    'NF LEGACY pediu aprovação',
  );
});

testStep('8. troca de conta numa NF já enviada à contabilidade: o e-mail da v2 diz o que ele substitui', async () => {
  assert.ok(fx.e, 'depende do passo 3');
  assert.equal(
    db(
      `select "accountingEmailSentAt" is not null from "RevalleInvoiceClassification" where "envelopeId" = '${fx.e.id}'`,
    ),
    't',
    'a versão anterior não tinha ido para a contabilidade (o caso não provaria nada)',
  );

  const changed = await finance(fx.fin.cookie, 'mutation', 'changeAccount', {
    envelopeId: fx.e.id,
    code: NEW.code,
    reason: REASON,
  });

  assert.equal(changed.status, 200, changed.text);

  const v2 = loadVersion(data(changed).newEnvelopeId);

  assert.equal(await waitStatus(v2.id, 'PENDING', 10), 'PENDING');
  await sign(v2, 0);
  assert.equal(await waitStatus(v2.id, 'COMPLETED'), 'COMPLETED');

  const [accounting] = await waitMails(ACCOUNTING, (m) => m.Subject === ACCOUNTING_SUBJECT(v2.title, NEW));

  assert.ok(accounting, 'a contabilidade não recebeu a v2');

  const accountingText = flat((await mailBody(accounting.ID)).Text);

  assert.ok(accountingText.includes(REPLACES_LINE(fx.e.title)), accountingText);
  assert.ok(accountingText.includes(CHANGED_LINE(fx.fin.name)), accountingText);
});

testStep('lista e planilha: colunas do Financeiro no fim, situações e quem aprovou', async () => {
  const rows = await csvRows(fx.fin.cookie);

  assert.equal(rows.get(fx.a.id)?.financeiro, 'Aprovada');
  assert.equal(rows.get(fx.a.id).aprovado_por, fx.fin.name);
  assert.match(rows.get(fx.a.id).link, new RegExp(`/notas-fiscais/${fx.a.id}$`));
  assert.equal(rows.get(fx.b.id)?.financeiro, 'Substituída');
  assert.equal(rows.get(fx.b2.id)?.financeiro, 'Aprovada');
  assert.equal(rows.get(fx.c.id)?.financeiro, 'Aprovada');
  assert.equal(rows.get(fx.d.id)?.financeiro, 'Antiga, sem aprovação');
  assert.equal(rows.get(fx.d.id).aprovado_por, '');

  // A planilha segue o filtro do Financeiro.
  const replaced = await csvRows(fx.fin.cookie, 'financeiro=substituidas');

  assert.ok(replaced.has(fx.b.id));
  assert.ok(!replaced.has(fx.a.id));

  // Terceiro: nenhuma destas NFs.
  const outsider = await csvRows(fx.outsider.cookie);

  for (const doc of [fx.a, fx.b, fx.b2, fx.c, fx.d]) {
    assert.ok(!outsider.has(doc.id), `o terceiro vê ${doc.title}`);
  }
});
