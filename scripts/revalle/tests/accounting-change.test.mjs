// Fase 7, Task 6: a Contabilidade valida e corrige o centro de custo, e a troca de conta e a correção usam o mesmo motor
// de nova versão (`createInvoiceNewVersion`). Confere:
//   - `validate`: quem não é da Contabilidade 403 (inclusive o admin não marcado), sem sessão 401; grava quem e quando;
//     repetir devolve `{ validated: false }`; versão substituída, NF sem centro e documento recusado = 400;
//   - a validação não segura a conclusão: todos assinam e o Financeiro aprova sem ela = COMPLETED;
//   - `changeCostCenter`: motivo curto, mesmo centro e centro fora da lista = 400; NF sem centro = 400;
//   - correção sem aprovação: antiga `SUPERSEDED` (`COST_CENTER`), link antigo bloqueado, v2 "(v2)" `PENDING_APPROVAL` com
//     a mesma conta, o centro novo e validada por quem corrigiu; convite e aviso com o motivo para todos; a prova da v2
//     guarda o centro novo e a da antiga o antigo; o Financeiro ainda precisa aprovar para concluir;
//   - correção com a NF aprovada: a v2 sai `APPROVED` com a aprovação copiada e conclui sem nova aprovação;
//   - correção com a NF concluída: a antiga continua `COMPLETED`, visível como "Substituída"; a v2 assina e sela;
//   - corrida com `finance.changeAccount`: exatamente uma sucessora, o perdedor recebe 400 ou 409 com mensagem clara e
//     nada fica `SUPERSEDED` sem sucessora; corrida com `finance.approve`: o perdedor recebe "A situação desta nota mudou";
//   - troca de conta: a v2 mantém o centro e a validação da v1;
//   - `defineCostCenter`: primeiro centro, gravado e validado no mesmo ato, sem nova versão; com centro, 400; a correção
//     de uma NF sem conta sai assim mesmo; nos dois casos, sem conta, quem assina vê o centro, a prova o guarda e o
//     certificado traz a linha do signatário; a conta definida com a página já aberta não entra na prova;
//   - NF `LEGACY`: pendente = 400; concluída e corrigida, a nova versão sai aguardando o Financeiro;
//   - envio atrasado (leu o rascunho antes da correção da nova versão) não ressuscita a versão substituída;
//   - falha no envio: `FINANCE_NEW_VERSION_NOT_SENT`, rascunho, `resendVersion` (Financeiro ou Contabilidade) envia sem
//     mexer na aprovação copiada, também em `PENDING_APPROVAL`, e um clique duplo envia uma vez só;
//   - falha ao criar a v2 desfaz a marca; marca que morreu no meio é retomada depois do prazo, nos dois tipos;
//   - rascunho de nova versão: Financeiro e Contabilidade abrem, listam e veem o cartão (`APPROVED` ou
//     `PENDING_APPROVAL`), o rascunho comum fica escondido, e o dono não troca conta nem centro do rascunho;
//   - o arquivo trocado no rascunho da v2 perde a isenção: o envio volta a exigir a conta e o centro, e a validação cai;
//   - `setCostCenter` e `setChoice` recusam a versão substituída.
//
// Sessões: REVSIGN_USER_* (admin@hml.local, dono do REVSIGN_API_TOKEN, fora dos perfis), REVSIGN_ADMIN_* (rsadmin, ADMIN,
// marcado como Financeiro e nunca como Contabilidade) e três contas novas a cada execução: a Contabilidade, um membro só
// do Financeiro (o admin abre tudo, então não prova a regra do rascunho) e um terceiro sem perfil. Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
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
  computeEmailCode,
  createEnvelope,
  db,
  distribute,
  downloadItem,
  fetchIdempotent,
  poppler,
  retryCreateOnStaleSocket,
  signIn,
  signupColaborador,
  trpc,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = `Cont-${RUN}-Senha!9`;
const MAILPIT = 'http://localhost:8025/api/v1';
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const origin = new URL(BASE_URL).origin;

const GATE_MESSAGE = 'Este documento foi substituído por uma nova versão.';
const REASON = 'O serviço foi do armazém, não da puxada.';
const NOTICE_LINE = 'O centro de custo foi corrigido de 101 – Puxada para 201 – Armazém.';
const NOTICE_SUBJECT = (title) => `Centro de custo da nota fiscal corrigido pela Contabilidade: ${title}`;
const SUPERSEDED_MESSAGE = 'Esta versão da nota fiscal já foi substituída';
const NO_CENTER_MESSAGE = 'Esta nota fiscal ainda não tem centro de custo.';
const SAME_CENTER_MESSAGE = 'Escolha um centro de custo diferente do atual.';
const REASON_MESSAGE = 'Escreva o motivo (de 10 a 500 caracteres).';
const STATE_CHANGED = 'A situação desta nota mudou';

const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
].join('\n');

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-contabilidade-troca-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userCookie;
let adminCookie;
let accountant;
let financeOnly;
let outsider;

const data = (res) => res.body?.result?.data?.json;
const errorOf = (res) => res.body?.error?.json ?? {};

const accounting = (name, input, cookie = accountant.cookie, kind = 'mutation') =>
  trpcAs(cookie, kind, `revalle.accounting.${name}`, input);
const validate = (envelopeId, cookie) => accounting('validate', { envelopeId }, cookie);
const correct = (envelopeId, { code = '201', reason = REASON, cookie } = {}) =>
  accounting('changeCostCenter', { envelopeId, code, reason }, cookie);
const define = (envelopeId, code = '201', cookie) => accounting('defineCostCenter', { envelopeId, code }, cookie);
const card = (envelopeId, cookie) => accounting('get', { envelopeId }, cookie, 'query');
const changeAccount = (envelopeId, { code = '3.1.01', reason = 'Conta de serviço, não de material.' } = {}) =>
  trpcAs(adminCookie, 'mutation', 'revalle.finance.changeAccount', { envelopeId, code, reason });
const financeCard = (envelopeId, cookie) => trpcAs(cookie, 'query', 'revalle.finance.get', { envelopeId });
const approve = (envelopeId) => trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', { envelopeId });
const resend = (envelopeId, cookie = accountant.cookie) =>
  trpcAs(cookie, 'mutation', 'revalle.finance.resendVersion', { envelopeId });

const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);
const invoiceRow = (envelopeId, columns) =>
  db(`select ${columns} from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`);
const financeStatus = (envelopeId) => invoiceRow(envelopeId, `coalesce("financeStatus"::text, '-')`);
const auditCount = (envelopeId, type) =>
  Number(db(`select count(*) from "DocumentAuditLog" where "envelopeId" = '${envelopeId}' and type = '${type}'`));
const successors = (envelopeId) =>
  db(`select "envelopeId" from "RevalleInvoiceClassification" where "previousEnvelopeId" = '${envelopeId}'`)
    .split('\n')
    .filter(Boolean);

const VALIDATION = `coalesce("costCenterValidatedById"::text, '-') || '|' || coalesce("costCenterValidatedByName", '-') || '|' || ("costCenterValidatedAt" is not null)`;
const COPIED_APPROVAL = `"approvedById" || '|' || "approvedAt"::text || '|' || "approvedAccountName" || '|' || "approvedByName"`;

const waitStatus = async (envelopeId, wanted, attempts = 45) => {
  for (let i = 0; i < attempts && status(envelopeId) !== wanted; i += 1) {
    await sleep(2000);
  }

  return status(envelopeId);
};

const mailsTo = async (to) =>
  (await fetchIdempotent(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`, {}, (res) => res.json()))
    .messages ?? [];
const mailBody = (id) => fetchIdempotent(`${MAILPIT}/message/${id}`, {}, (res) => res.json());
const flat = (text) => (text ?? '').replace(/\s+/g, ' ');

const waitMails = async (to, filter, timeoutMs = 30_000) => {
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

// Convite de uma versão: o e-mail com o link do token dela que não é o aviso da correção.
const waitInvite = async (email, token, title, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;

  do {
    for (const mail of await mailsTo(email)) {
      if (mail.Subject !== NOTICE_SUBJECT(title) && (await mailBody(mail.ID)).Text?.includes(`/sign/${token}`)) {
        return true;
      }
    }

    await sleep(1000);
  } while (Date.now() < deadline);

  return false;
};

const newAccount = async (label) => {
  const email = `f7-ct-${label}-${RUN}@revalle.com.br`;
  const created = await signupColaborador({ name: `Contabilidade Teste ${label}`, email, password: PASSWORD });

  assert.ok(created.ok, `cadastro de ${label} falhou (${created.status}): ${await created.text()}`);

  const [message] = await waitMails(email, () => true, 40_000);

  assert.ok(message, `e-mail de confirmação de ${label} não chegou`);

  const html = (await mailBody(message.ID)).HTML ?? '';
  const token = html.match(/\/verify-email\/([A-Za-z0-9_-]+)/)?.[1];

  assert.ok(token, `link de confirmação ausente para ${label}`);

  const verified = await fetch(`${BASE_URL}/api/auth/email-password/verify-email`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  assert.equal(verified.status, 200, await verified.text());

  return {
    email,
    name: `Contabilidade Teste ${label}`,
    id: Number(db(`select id from "User" where email = '${email}'`)),
    cookie: await signIn(email, PASSWORD),
  };
};

// DANFE fictício; `variant` muda o arquivo (outra SHA-256, sem cache da sugestão).
const danfe = async (variant) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  let y = 800;

  for (const line of [
    'DANFE - Documento Auxiliar da Nota Fiscal Eletrônica',
    'Nº 000.012.345   Série 001',
    'Chave de Acesso',
    '2924 1012 3456 7800 0195 5500 1000 0123 4511 2345 6784',
    'Natureza da Operação: Venda de mercadoria adquirida de terceiros',
    'Emitente: Distribuidora Fictícia de Ferragens Ltda   CNPJ 12.345.678/0001-95',
    `Referência do teste: contabilidade troca ${variant} ${RUN}`,
    'Valor Total da Nota: R$ 150,00',
  ]) {
    page.drawText(line, { x: 40, y, size: 10, font, color: rgb(0, 0, 0) });
    y -= 16;
  }

  const file = path.join(tmp, `danfe-${variant}.pdf`);

  writeFileSync(file, Buffer.from(await doc.save()));

  return file;
};

// Lê uma versão do banco: destinatários (com token) e campos, como a tela de assinatura usa.
const loadVersion = (envelopeId) => {
  const [secondaryId, title] = db(`select "secondaryId" || '|' || title from "Envelope" where id = '${envelopeId}'`)
    .split(/\|(.*)/s)
    .slice(0, 2);
  const recipients = db(
    `select id || '|' || token || '|' || email from "Recipient" where "envelopeId" = '${envelopeId}' order by email`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, token, email] = line.split('|');

      return { id: Number(id), token, email };
    });
  const fields = db(
    `select id || '|' || "recipientId" || '|' || type from "Field" where "envelopeId" = '${envelopeId}' order by id`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, recipientId, type] = line.split('|');

      return { id: Number(id), recipientId: Number(recipientId), type };
    });

  return { id: envelopeId, title, documentId: Number.parseInt(secondaryId.split('_')[1], 10), recipients, fields };
};

// NF com a conta 2.1.03 e o centro 101, do usuário comum. `send: false` deixa o rascunho.
const newInvoice = async (label, { signers = 1, meta, send = true, center = '101' } = {}) => {
  const emails = Array.from({ length: signers }, (_, index) => `f7-ct-${label}-${index + 1}-${RUN}@revalle.com.br`);
  const title = `[TESTE NF] contabilidade ${label} ${RUN}`;
  const pdf = await danfe(label);
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({ recipients: emails.map((email) => ({ email })), pdf, title, meta }),
  );

  assert.equal(created.status, 200, created.text);

  const chosen = await chooseInvoice({ cookie: userCookie, envelopeId: created.id, costCenter: center });

  assert.equal(chosen.status, 200, chosen.text);

  if (send) {
    assert.equal((await distribute(created.id)).length, signers);
    assert.equal(financeStatus(created.id), 'PENDING_APPROVAL');
  }

  return loadVersion(created.id);
};

// NF com dois arquivos (para o teste que troca o arquivo do rascunho da v2 pela API, apagando um deles).
const newInvoiceWithTwoFiles = async (label) => {
  const form = new FormData();
  const email = `f7-ct-${label}-${RUN}@revalle.com.br`;
  const title = `[TESTE NF] contabilidade ${label} ${RUN}`;
  // O DANFE primeiro: o campo de assinatura fica no primeiro arquivo, e o teste apaga o outro.
  const files = [await danfe(label), 'assets/example.pdf'];

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
          email,
          fields: [{ type: 'SIGNATURE', page: 1, positionX: 10, positionY: 80, width: 30, height: 8 }],
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

  const { id } = created.body;

  assert.equal((await chooseInvoice({ cookie: userCookie, envelopeId: id })).status, 200);
  assert.equal((await distribute(id)).length, 1);

  return loadVersion(id);
};

const gate = async (token) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

const signingPage = (token) => fetchIdempotent(`${BASE_URL}/sign/${token}`, {}, async (res) => res.text());

const signField = (doc, recipient) => {
  const field = doc.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');

  return trpc('envelope.field.sign', {
    token: recipient.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Teste Digitado' },
  });
};

// Portão, página aberta (a prova só congela o que a página mostrou), assinatura e conclusão. O código é calculado no
// container do app: aqui chegam vários e-mails ao mesmo tempo (convite e aviso), e ler "o último" no Mailpit daria erro.
const sign = async (doc, index, { afterPageOpens } = {}) => {
  const recipient = doc.recipients[index];

  await gate(recipient.token);

  const page = await signingPage(recipient.token);

  await afterPageOpens?.();

  const signed = await signField(doc, recipient);

  assert.equal(signed.status, 200, signed.text);

  const completion = await trpc('recipient.completeDocumentWithToken', {
    token: recipient.token,
    documentId: doc.documentId,
    accessAuthOptions: {
      type: 'TWO_FACTOR_AUTH',
      method: 'email',
      token: computeEmailCode({ email: recipient.email, envelopeId: doc.id }),
    },
  });

  assert.ok(completion.ok, completion.text);
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);

  return page;
};

// O que a prova de quem assinou congelou: `conta|centro`, com "-" para o que ela não guardou.
const proofOf = (recipientId) =>
  db(
    `select coalesce("invoiceAccount"->>'code', '-') || '|' || coalesce("invoiceCostCenter"->>'code', '-') from "RevalleSignatureProof" where "recipientId" = ${recipientId}`,
  );

// Texto do PDF selado (documento, certificado e log), com os espaços normalizados.
const sealedText = async (envelopeId) => {
  const dir = mkdtempSync(path.join(tmp, 'selado-'));
  const itemId = db(`select id from "EnvelopeItem" where "envelopeId" = '${envelopeId}' order by "order" limit 1`);

  writeFileSync(path.join(dir, 'signed.pdf'), await downloadItem(itemId, 'signed'));

  return poppler(dir, 'pdftotext /pdf/signed.pdf -').replace(/\s+/g, ' ');
};

const signAll = async (doc) => {
  for (let index = 0; index < doc.recipients.length; index += 1) {
    await sign(doc, index);
  }
};

const changed = (res) => {
  assert.equal(res.status, 200, res.text);

  const newEnvelopeId = data(res)?.newEnvelopeId;

  assert.ok(newEnvelopeId, res.text);

  return newEnvelopeId;
};

const refused = (res, message, label = message) => {
  assert.equal(res.status, 400, `${label}: ${res.text}`);
  assert.ok(errorOf(res).message?.includes(message), `${label}: ${res.text}`);
};

// Correção cujo envio da v2 é recusado (destinatário de fora dos domínios, posto no banco): 409 claro e a v2 em rascunho.
const correctWithFailedSend = async (doc, label) => {
  db(`update "Recipient" set email = 'f7-ct-fora-${label}-${RUN}@example.com' where "envelopeId" = '${doc.id}'`);

  const res = await correct(doc.id);

  assert.equal(res.status, 409, res.text);
  assert.equal(errorOf(res).data?.code, 'FINANCE_NEW_VERSION_NOT_SENT', res.text);
  assert.ok(errorOf(res).message?.includes(`"${doc.title} (v2)"`), res.text);

  const [v2] = successors(doc.id);

  assert.ok(v2, 'a v2 não ficou criada');
  assert.equal(status(v2), 'DRAFT');
  assert.equal(financeStatus(doc.id), 'SUPERSEDED');
  assert.equal(invoiceRow(doc.id, '"supersededByEnvelopeId"'), v2);

  return v2;
};

const fixRecipient = (envelopeId, label) => {
  const email = `f7-ct-corrigido-${label}-${RUN}@revalle.com.br`;

  db(`update "Recipient" set email = '${email}' where "envelopeId" = '${envelopeId}'`);

  return email;
};

const findRows = async (cookie) => {
  const res = await trpcAs(cookie, 'query', 'revalle.invoice.find', { perPage: 100 });

  assert.equal(res.status, 200, res.text);

  return data(res).data;
};

const invoicePage = (cookie, envelopeId) =>
  fetchIdempotent(
    `${BASE_URL}/notas-fiscais/${envelopeId}`,
    { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' },
    async (res) => ({ status: res.status, text: await res.text() }),
  );

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

  const adminId = Number(db(`select id from "User" where email = '${admin.email}'`));
  const userId = Number(db(`select id from "User" where email = '${user.email}'`));
  const marked = await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', {
    userId: adminId,
    member: true,
  });

  assert.equal(marked.status, 200, marked.text);
  db(`delete from "RevalleFinanceMember" where "userId" = ${userId}`);
  db(`delete from "RevalleAccountingMember" where "userId" in (${userId}, ${adminId})`);

  const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });

  assert.equal(imported.status, 200, imported.text);
  db(`delete from "RateLimit"`);

  accountant = await newAccount('membro');
  financeOnly = await newAccount('financeiro');
  outsider = await newAccount('terceiro');

  const added = await trpcAs(adminCookie, 'mutation', 'revalle.accounting.adminSetMember', {
    userId: accountant.id,
    isMember: true,
  });

  assert.equal(added.status, 200, added.text);

  const addedFinance = await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', {
    userId: financeOnly.id,
    member: true,
  });

  assert.equal(addedFinance.status, 200, addedFinance.text);
});

after(() => {
  if (accountant) {
    db(`delete from "RevalleAccountingMember" where "userId" = ${accountant.id}`);
  }

  if (financeOnly) {
    db(`delete from "RevalleFinanceMember" where "userId" = ${financeOnly.id}`);
  }
});

sessionTest(
  'só a Contabilidade: 403 para quem não é, inclusive o admin não marcado; sem sessão, 401; nada muda',
  async () => {
    const doc = await newInvoice('perfil');

    for (const cookie of [userCookie, adminCookie, outsider.cookie]) {
      assert.equal((await validate(doc.id, cookie)).status, 403);
      assert.equal((await correct(doc.id, { cookie })).status, 403);
      assert.equal((await define(doc.id, '201', cookie)).status, 403);
      assert.equal((await card(doc.id, cookie)).status, 403);
    }

    assert.equal((await validate(doc.id, '')).status, 401);
    assert.equal(invoiceRow(doc.id, VALIDATION), '-|-|false');
    assert.deepEqual(successors(doc.id), []);
  },
);

sessionTest('validar: grava quem e quando; repetir não faz nada; o evento sai uma vez', async () => {
  const doc = await newInvoice('validar');
  const before = await card(doc.id);

  assert.equal(before.status, 200, before.text);
  assert.deepEqual(data(before).costCenter, { code: '101', name: 'Puxada' });
  assert.equal(data(before).validatedAt, null);

  const first = await validate(doc.id);

  assert.equal(first.status, 200, first.text);
  assert.deepEqual(data(first), { validated: true });
  assert.equal(invoiceRow(doc.id, VALIDATION), `${accountant.id}|${accountant.name}|true`);

  const after = data(await card(doc.id));

  assert.equal(after.validatedBy, accountant.name);
  assert.ok(after.validatedAt, 'o cartão não mostra quando foi validado');

  const stamp = invoiceRow(doc.id, '"costCenterValidatedAt"::text');
  const again = await validate(doc.id);

  assert.equal(again.status, 200, again.text);
  assert.deepEqual(data(again), { validated: false });
  assert.equal(invoiceRow(doc.id, '"costCenterValidatedAt"::text'), stamp);
  assert.equal(auditCount(doc.id, 'REVALLE_COST_CENTER_VALIDATED'), 1);
  assert.equal(
    db(
      `select data->>'code' from "DocumentAuditLog" where "envelopeId" = '${doc.id}' and type = 'REVALLE_COST_CENTER_VALIDATED'`,
    ),
    '101',
  );
});

sessionTest('validar: rascunho, versão substituída, NF sem centro e documento recusado = 400', async () => {
  const draft = await newInvoice('validar-rascunho', { send: false });

  assert.equal((await validate(draft.id)).status, 400);

  const replaced = await newInvoice('validar-substituida');

  changed(await changeAccount(replaced.id));
  refused(await validate(replaced.id), SUPERSEDED_MESSAGE);

  const noCenter = await newInvoice('validar-sem-centro');

  db(
    `update "RevalleInvoiceClassification" set "costCenterCode" = null, "costCenterById" = null, "costCenterAt" = null where "envelopeId" = '${noCenter.id}'`,
  );
  refused(await validate(noCenter.id), NO_CENTER_MESSAGE);

  const rejected = await newInvoice('validar-recusada');

  await gate(rejected.recipients[0].token);

  const refusal = await trpc('recipient.rejectDocumentWithToken', {
    token: rejected.recipients[0].token,
    documentId: rejected.documentId,
    reason: 'Teste',
  });

  assert.equal(refusal.status, 200, refusal.text);
  assert.equal((await validate(rejected.id)).status, 400);
  assert.equal(invoiceRow(rejected.id, VALIDATION), '-|-|false');
});

sessionTest('a validação não segura a conclusão: todos assinam, o Financeiro aprova, conclui sem validar', async () => {
  const doc = await newInvoice('sem-validacao', { signers: 2 });

  await signAll(doc);
  await sleep(1000);
  assert.equal(status(doc.id), 'PENDING');
  assert.equal((await approve(doc.id)).status, 200);
  assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');
  assert.equal(invoiceRow(doc.id, VALIDATION), '-|-|false');
});

sessionTest('corrigir: motivo curto, mesmo centro, centro fora da lista e NF sem centro = 400; nada muda', async () => {
  const doc = await newInvoice('corrigir-validacao');

  refused(await correct(doc.id, { reason: 'curto' }), '');
  refused(await correct(doc.id, { reason: '   123456789   ' }), '');
  refused(await correct(doc.id, { code: '101' }), SAME_CENTER_MESSAGE);
  assert.equal((await correct(doc.id, { code: '999' })).status, 400);
  assert.equal(financeStatus(doc.id), 'PENDING_APPROVAL');
  assert.deepEqual(successors(doc.id), []);

  const short = await correct(doc.id, { reason: 'x'.repeat(9) });

  assert.ok(errorOf(short).message?.includes(REASON_MESSAGE), short.text);

  const noCenter = await newInvoice('corrigir-sem-centro');

  db(
    `update "RevalleInvoiceClassification" set "costCenterCode" = null, "costCenterById" = null, "costCenterAt" = null where "envelopeId" = '${noCenter.id}'`,
  );
  refused(await correct(noCenter.id), NO_CENTER_MESSAGE);
  assert.deepEqual(successors(noCenter.id), []);
});

sessionTest(
  'correção sem aprovação: antiga substituída e bloqueada; v2 PENDING_APPROVAL com o centro novo; aviso e convites; a prova guarda cada centro; o Financeiro ainda aprova',
  async () => {
    const doc = await newInvoice('sem-aprovacao', { signers: 2, meta: { distributionMethod: 'EMAIL' } });

    await sign(doc, 0);

    const res = await correct(doc.id);
    const v2Id = changed(res);

    // Antiga: substituída, com quem/quando/motivo/ligação, tipo, escondida.
    assert.equal(
      invoiceRow(
        doc.id,
        `"financeStatus" || '|' || "supersedeKind" || '|' || "supersededById" || '|' || "supersedeReason" || '|' || "supersededByEnvelopeId"`,
      ),
      `SUPERSEDED|COST_CENTER|${accountant.id}|${REASON}|${v2Id}`,
    );
    assert.equal(db(`select "deletedAt" is not null from "Envelope" where id = '${doc.id}'`), 't');
    assert.equal(invoiceRow(doc.id, '"costCenterCode"'), '101');

    // Link antigo bloqueado, com o código do portão, inclusive para quem estava com a página aberta.
    const blocked = await signField(doc, doc.recipients[1]);

    assert.equal(blocked.status, 409, blocked.text);
    assert.equal(errorOf(blocked).data?.code, 'REVALLE_DOCUMENT_SUPERSEDED', blocked.text);
    assert.ok(blocked.text.includes(GATE_MESSAGE), blocked.text);
    assert.ok((await signingPage(doc.recipients[1].token)).includes(GATE_MESSAGE));

    // Nova: "(v2)", mesma conta, situação copiada, centro novo, validada por quem corrigiu.
    assert.equal(await waitStatus(v2Id, 'PENDING', 15), 'PENDING');

    const v2 = loadVersion(v2Id);

    assert.equal(v2.title, `${doc.title} (v2)`);
    assert.equal(
      invoiceRow(
        v2Id,
        `"choiceCode" || '|' || "financeStatus" || '|' || "costCenterCode" || '|' || "costCenterById" || '|' || version || '|' || "previousEnvelopeId"`,
      ),
      `2.1.03|PENDING_APPROVAL|201|${accountant.id}|2|${doc.id}`,
    );
    assert.equal(invoiceRow(v2Id, VALIDATION), `${accountant.id}|${accountant.name}|true`);
    assert.equal(invoiceRow(v2Id, `"approvedAt" is null`), 't');

    // Evento nas duas versões, com a ligação.
    for (const [envelopeId, other, isNewVersion] of [
      [doc.id, v2Id, 'false'],
      [v2Id, doc.id, 'true'],
    ]) {
      assert.equal(
        db(
          `select (data->>'fromCode') || '|' || (data->>'toCode') || '|' || (data->>'reason') || '|' || (data->>'otherEnvelopeId') || '|' || (data->>'isNewVersion') from "DocumentAuditLog" where "envelopeId" = '${envelopeId}' and type = 'REVALLE_COST_CENTER_CHANGED'`,
        ),
        `101|201|${REASON}|${other}|${isNewVersion}`,
      );
    }

    // Aviso com a frase e o motivo a todos, cada um com o link certo; convite da v2 a quem assina.
    for (const [to, link] of [
      [user.email, `/notas-fiscais/${v2Id}`],
      ...v2.recipients.map((recipient) => [recipient.email, `/sign/${recipient.token}`]),
    ]) {
      const notices = await waitMails(to, (m) => m.Subject === NOTICE_SUBJECT(doc.title));

      assert.equal(notices.length, 1, `aviso para ${to}`);

      const body = await mailBody(notices[0].ID);

      assert.ok(flat(body.Text).includes(NOTICE_LINE), flat(body.Text));
      assert.ok(flat(body.Text).includes(`Motivo: ${REASON}`), flat(body.Text));
      assert.ok(body.Text.includes(link), `aviso para ${to} sem o link ${link}`);
    }

    for (const recipient of v2.recipients) {
      assert.ok(await waitInvite(recipient.email, recipient.token, doc.title), `convite para ${recipient.email}`);
    }

    // O cartão aponta de uma versão para a outra e a página diz o que mudou.
    const oldCard = data(await card(doc.id));

    assert.equal(oldCard.supersededByEnvelopeId, v2Id);
    assert.equal(oldCard.supersedeKind, 'COST_CENTER');
    assert.equal(oldCard.supersedeReason, REASON);
    assert.equal(data(await card(v2Id)).validatedBy, accountant.name);

    const oldPage = await invoicePage(accountant.cookie, doc.id);

    assert.equal(oldPage.status, 200);
    assert.ok(oldPage.text.includes('centro de custo corrigido pela Contabilidade'), 'a página não diz o que mudou');
    assert.ok(!oldPage.text.includes('conta contábil alterada'), 'a página fala de conta numa correção de centro');

    // Quem só está vendo também vê o centro.
    assert.ok((await invoicePage(userCookie, v2Id)).text.includes('201 – Armazém'), 'o dono não vê o centro');

    // O /verificar da antiga diz o que aconteceu, sem nada da nova.
    const oldCode = db(
      `select "verificationCode" from "RevalleSignatureProof" where "recipientId" = ${doc.recipients[0].id}`,
    );
    const verify = await fetchIdempotent(`${BASE_URL}/verificar?codigo=${encodeURIComponent(oldCode)}`, {}, async (r) =>
      r.text(),
    );

    assert.ok(verify.includes('Substituído por uma nova versão em'), '/verificar sem a substituição');
    assert.ok(verify.includes('(centro de custo corrigido)'), '/verificar sem o motivo da substituição');
    assert.ok(!verify.includes('(conta contábil alterada)'), '/verificar fala de conta numa correção de centro');
    assert.ok(!verify.includes(v2Id), '/verificar mostra a nova versão');

    // Quem assina vê o centro novo; a prova da v2 guarda o novo e a da antiga, o antigo.
    const page = await sign(v2, 0);

    assert.ok(page.includes('Centro de custo: 201 – Armazém'), 'a página da v2 não mostra o centro novo');
    await sign(v2, 1);

    const proofCenter = (recipientId) =>
      db(`select "invoiceCostCenter"->>'code' from "RevalleSignatureProof" where "recipientId" = ${recipientId}`);

    assert.equal(proofCenter(v2.recipients[0].id), '201');
    assert.equal(proofCenter(doc.recipients[0].id), '101');

    // Todos assinaram e a selagem espera o Financeiro.
    await sleep(2000);
    assert.equal(status(v2Id), 'PENDING');
    assert.equal(financeStatus(v2Id), 'PENDING_APPROVAL');

    assert.equal((await approve(v2Id)).status, 200);
    assert.equal(await waitStatus(v2Id, 'COMPLETED'), 'COMPLETED');
    assert.equal(status(doc.id), 'PENDING', 'a versão substituída foi concluída');
  },
);

sessionTest(
  'correção com a NF aprovada: a v2 sai APPROVED com a aprovação copiada e conclui sem aprovar de novo',
  async () => {
    const doc = await newInvoice('aprovada');

    assert.equal((await approve(doc.id)).status, 200);

    const approval = invoiceRow(doc.id, COPIED_APPROVAL);
    const v2Id = changed(await correct(doc.id));

    assert.equal(await waitStatus(v2Id, 'PENDING', 15), 'PENDING');
    assert.equal(financeStatus(v2Id), 'APPROVED');
    assert.equal(invoiceRow(v2Id, COPIED_APPROVAL), approval, 'a aprovação não foi copiada');
    assert.equal(invoiceRow(v2Id, `"choiceCode" || '|' || "costCenterCode"`), '2.1.03|201');
    assert.equal(auditCount(v2Id, 'REVALLE_FINANCE_APPROVED'), 0);

    await signAll(loadVersion(v2Id));
    assert.equal(await waitStatus(v2Id, 'COMPLETED'), 'COMPLETED');
    assert.equal(invoiceRow(v2Id, COPIED_APPROVAL), approval, 'o envio ou a selagem mexeram na aprovação copiada');
  },
);

sessionTest(
  'correção com a NF concluída: a antiga continua concluída e "Substituída"; a v2 assina e sela',
  async () => {
    const doc = await newInvoice('concluida');

    assert.equal((await approve(doc.id)).status, 200);
    await signAll(doc);
    assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');

    const v2Id = changed(await correct(doc.id));

    assert.equal(status(doc.id), 'COMPLETED');
    assert.equal(financeStatus(doc.id), 'SUPERSEDED');
    assert.equal(db(`select "deletedAt" is null from "Envelope" where id = '${doc.id}'`), 't');

    const [old] = (await findRows(accountant.cookie)).filter((row) => row.id === doc.id);

    assert.equal(old?.financeStatus, 'SUPERSEDED', 'a versão concluída sumiu da lista');
    assert.equal(old?.status, 'COMPLETED');
    assert.equal((await invoicePage(accountant.cookie, doc.id)).status, 200);

    assert.equal(await waitStatus(v2Id, 'PENDING', 15), 'PENDING');
    await signAll(loadVersion(v2Id));
    assert.equal(await waitStatus(v2Id, 'COMPLETED'), 'COMPLETED');
    assert.equal(status(doc.id), 'COMPLETED');
  },
);

sessionTest(
  'corrida com a troca de conta: uma sucessora só; o perdedor recebe erro claro; nada fica sem sucessora',
  async () => {
    for (let round = 0; round < 3; round += 1) {
      const doc = await newInvoice(`corrida-${round}`);
      const results = await Promise.all([correct(doc.id), changeAccount(doc.id)]);
      const texts = results.map((r) => r.text).join('\n');
      const winners = results.filter((r) => r.status === 200);
      const losers = results.filter((r) => r.status !== 200);

      assert.equal(winners.length, 1, texts);
      assert.ok([400, 409].includes(losers[0].status), texts);
      assert.ok(
        errorOf(losers[0]).message?.includes(STATE_CHANGED) || errorOf(losers[0]).message?.includes(SUPERSEDED_MESSAGE),
        texts,
      );

      const [v2Id, ...others] = successors(doc.id);

      assert.deepEqual(others, [], texts);
      assert.equal(data(winners[0]).newEnvelopeId, v2Id);
      assert.equal(financeStatus(doc.id), 'SUPERSEDED');
      assert.equal(invoiceRow(doc.id, '"supersededByEnvelopeId"'), v2Id);

      const kind = invoiceRow(doc.id, '"supersedeKind"');
      const events = [
        auditCount(doc.id, 'REVALLE_COST_CENTER_CHANGED'),
        auditCount(doc.id, 'REVALLE_FINANCE_ACCOUNT_CHANGED'),
      ];

      assert.deepEqual(events, kind === 'COST_CENTER' ? [1, 0] : [0, 1], `tipo ${kind}`);
      assert.equal(
        invoiceRow(v2Id, `"choiceCode" || '|' || "costCenterCode"`),
        kind === 'COST_CENTER' ? '2.1.03|201' : '3.1.01|101',
      );
      assert.equal(await waitStatus(v2Id, 'PENDING', 15), 'PENDING');
    }
  },
);

sessionTest('corrida com a aprovação: só um vence na mesma leitura; a v2 leva a situação que valia', async () => {
  for (let round = 0; round < 3; round += 1) {
    const doc = await newInvoice(`corrida-aprovar-${round}`);
    const [approved, corrected] = await Promise.all([approve(doc.id), correct(doc.id)]);
    const texts = `${approved.text}\n${corrected.text}`;

    assert.ok(approved.status === 200 || corrected.status === 200, texts);

    for (const res of [approved, corrected]) {
      if (res.status !== 200) {
        refused(res, STATE_CHANGED, texts);
      }
    }

    const [v2Id, ...others] = successors(doc.id);

    assert.deepEqual(others, [], texts);
    assert.equal(Boolean(v2Id), corrected.status === 200, texts);

    if (v2Id) {
      // As duas passaram: a aprovação veio antes da correção, e a nova versão a leva.
      assert.equal(financeStatus(v2Id), approved.status === 200 ? 'APPROVED' : 'PENDING_APPROVAL', texts);
      assert.equal(financeStatus(doc.id), 'SUPERSEDED');
    } else {
      assert.equal(financeStatus(doc.id), 'APPROVED');
    }
  }

  // Quem aprova com a página aberta depois da correção: a nota mudou, não sumiu (ela fica escondida como excluída).
  const doc = await newInvoice('aprovar-depois');

  changed(await correct(doc.id));
  refused(await approve(doc.id), STATE_CHANGED);
});

sessionTest('troca de conta pelo Financeiro: a v2 mantém o centro e a validação da v1', async () => {
  const doc = await newInvoice('troca-mantem');

  assert.equal((await validate(doc.id)).status, 200);

  const columns = `"costCenterCode" || '|' || "costCenterById" || '|' || "costCenterAt"::text || '|' || "costCenterValidatedAt"::text || '|' || "costCenterValidatedById" || '|' || "costCenterValidatedByName"`;
  const expected = invoiceRow(doc.id, columns);
  const v2Id = changed(await changeAccount(doc.id));

  assert.equal(invoiceRow(v2Id, columns), expected);
  assert.equal(invoiceRow(doc.id, '"supersedeKind"'), 'ACCOUNT');
  assert.equal(financeStatus(v2Id), 'APPROVED');
  assert.equal(await waitStatus(v2Id, 'PENDING', 15), 'PENDING');

  // Corrigir depois da troca: a aprovação da troca vem junto, o centro e a validação são de quem corrigiu.
  const approval = invoiceRow(v2Id, COPIED_APPROVAL);
  const v3Id = changed(await correct(v2Id));

  assert.equal(loadVersion(v3Id).title, `${doc.title} (v3)`);
  assert.equal(invoiceRow(v3Id, COPIED_APPROVAL), approval);
  assert.equal(invoiceRow(v3Id, `"choiceCode" || '|' || "costCenterCode" || '|' || version`), '3.1.01|201|3');
  assert.equal(invoiceRow(v3Id, VALIDATION), `${accountant.id}|${accountant.name}|true`);
});

sessionTest(
  'definir: NF marcada depois do envio ganha o centro, validado no mesmo ato, sem nova versão; com centro, 400; a correção dela sai sem conta',
  async () => {
    const email = `f7-ct-marcada-${RUN}@revalle.com.br`;
    const common = await retryCreateOnStaleSocket(() =>
      createEnvelope({ recipients: [{ email }], title: `[TESTE] contabilidade marcada ${RUN}` }),
    );

    assert.equal(common.status, 200, common.text);
    assert.equal((await distribute(common.id)).length, 1);

    const marked = await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: common.id });

    assert.equal(marked.status, 200, marked.text);
    assert.equal(financeStatus(common.id), 'PENDING_APPROVAL');

    const before = data(await card(common.id));

    assert.equal(before.costCenter, null);
    refused(await validate(common.id), NO_CENTER_MESSAGE);
    assert.equal((await define(common.id, '999')).status, 400);

    const defined = await define(common.id, '301');

    assert.equal(defined.status, 200, defined.text);
    assert.equal(
      invoiceRow(common.id, `"costCenterCode" || '|' || "costCenterById" || '|' || ("costCenterAt" is not null)`),
      `301|${accountant.id}|true`,
    );
    assert.equal(invoiceRow(common.id, VALIDATION), `${accountant.id}|${accountant.name}|true`);
    assert.deepEqual(successors(common.id), []);
    assert.equal(status(common.id), 'PENDING');
    assert.equal(auditCount(common.id, 'REVALLE_INVOICE_COST_CENTER_SET'), 1);
    assert.equal(auditCount(common.id, 'REVALLE_COST_CENTER_VALIDATED'), 1);

    assert.equal((await define(common.id, '401')).status, 400);
    assert.equal(invoiceRow(common.id, '"costCenterCode"'), '301');

    // NF com centro e sem conta: a correção segue a mesma, e a nova versão sai ainda sem conta, aguardando o Financeiro.
    const v2Id = changed(await correct(common.id));

    assert.equal(await waitStatus(v2Id, 'PENDING', 15), 'PENDING');
    assert.equal(invoiceRow(v2Id, `coalesce("choiceCode", '-') || '|' || "costCenterCode"`), '-|201');
    assert.equal(financeStatus(v2Id), 'PENDING_APPROVAL');

    const notices = await waitMails(email, (m) => m.Subject === NOTICE_SUBJECT(`[TESTE] contabilidade marcada ${RUN}`));

    assert.equal(notices.length, 1, 'o aviso da correção da NF sem conta não saiu');

    // A versão substituída não recebe a primeira conta: a nova versão é que vale.
    const lateChoice = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
      envelopeId: common.id,
      choice: { code: '2.1.03' },
    });

    assert.equal(lateChoice.status, 403, lateChoice.text);
    assert.ok(errorOf(lateChoice).message?.includes(SUPERSEDED_MESSAGE), lateChoice.text);
    assert.equal(invoiceRow(common.id, `coalesce("choiceCode", '-')`), '-');

    // Todos assinam de novo por causa do centro: quem assina precisa vê-lo, mesmo sem conta, e a prova guarda o que a
    // página mostrou. A conta definida com a página já aberta não entra na prova: ela não foi vista.
    const v2 = loadVersion(v2Id);
    const page = await sign(v2, 0, {
      afterPageOpens: async () => {
        const definedAccount = await trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', {
          envelopeId: v2Id,
          code: '2.1.03',
        });

        assert.equal(definedAccount.status, 200, definedAccount.text);
      },
    });

    assert.ok(page.includes('Nota fiscal · Centro de custo: 201 – Armazém'), 'a página não mostra o centro corrigido');
    assert.ok(!page.includes('Nota fiscal · Conta contábil'), 'a página mostrou uma conta que não existia');
    assert.equal(proofOf(v2.recipients[0].id), '-|201');
    assert.equal(await waitStatus(v2Id, 'COMPLETED'), 'COMPLETED');

    const sealed = await sealedText(v2Id);

    assert.ok(sealed.includes('Centro de custo visto ao assinar: 201'), 'o certificado não traz a linha do signatário');
    assert.ok(sealed.includes('Centro de custo: 201 – Armazém'), 'o certificado não traz a linha do documento');
    assert.ok(!sealed.includes('Conta contábil vista ao assinar'), 'o certificado afirma uma conta que não foi vista');
  },
);

sessionTest(
  'primeiro centro definido numa NF marcada depois do envio: quem assina depois o vê, e a prova o guarda',
  async () => {
    const common = await retryCreateOnStaleSocket(() =>
      createEnvelope({
        recipients: [{ email: `f7-ct-primeiro-centro-${RUN}@revalle.com.br` }],
        title: `[TESTE] contabilidade primeiro centro ${RUN}`,
      }),
    );

    assert.equal(common.status, 200, common.text);
    assert.equal((await distribute(common.id)).length, 1);
    assert.equal(
      (await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: common.id })).status,
      200,
    );
    assert.equal((await define(common.id, '301')).status, 200);

    const doc = loadVersion(common.id);
    const page = await sign(doc, 0);

    assert.ok(page.includes('Nota fiscal · Centro de custo: 301 – Administrativo'), 'a página não mostra o centro');
    assert.equal(proofOf(doc.recipients[0].id), '-|301');
  },
);

sessionTest('NF LEGACY: pendente = 400; concluída e corrigida, a nova versão sai aguardando o Financeiro', async () => {
  const doc = await newInvoice('legacy');

  db(`update "RevalleInvoiceClassification" set "financeStatus" = 'LEGACY' where "envelopeId" = '${doc.id}'`);
  assert.equal((await correct(doc.id)).status, 400);
  assert.deepEqual(successors(doc.id), []);

  // LEGACY conclui sem o Financeiro.
  await signAll(doc);
  assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');

  const v2Id = changed(await correct(doc.id));

  assert.equal(status(doc.id), 'COMPLETED');
  assert.equal(invoiceRow(doc.id, `"financeStatus" || '|' || "supersedeKind"`), 'SUPERSEDED|COST_CENTER');
  assert.equal(await waitStatus(v2Id, 'PENDING', 15), 'PENDING');
  assert.equal(invoiceRow(v2Id, `"financeStatus" || '|' || ("approvedAt" is null)`), 'PENDING_APPROVAL|true');

  // A nova versão não pula o Financeiro: assinada por todos, a selagem espera a aprovação.
  await signAll(loadVersion(v2Id));
  await sleep(2000);
  assert.equal(status(v2Id), 'PENDING');
  assert.equal((await approve(v2Id)).status, 200);
  assert.equal(await waitStatus(v2Id, 'COMPLETED'), 'COMPLETED');
});

// Sem depender de tempo: o banco já tem o que um envio atrasado encontraria na marca "aguardando aprovação". Ele leu o
// rascunho, outro envio saiu, e a Contabilidade corrigiu essa versão antes de ele chegar à marca.
sessionTest('envio atrasado não ressuscita a versão substituída', async () => {
  const doc = await newInvoice('envio-atrasado');
  const v2Id = await correctWithFailedSend(doc, 'envio-atrasado');

  fixRecipient(v2Id, 'envio-atrasado');
  db(`update "RevalleInvoiceClassification" set "financeStatus" = 'SUPERSEDED' where "envelopeId" = '${v2Id}'`);

  await api('POST', '/envelope/distribute', { envelopeId: v2Id });

  assert.equal(financeStatus(v2Id), 'SUPERSEDED', 'o envio tirou a marca de versão substituída');
});

sessionTest(
  'falha no envio em PENDING_APPROVAL: rascunho travado; a Contabilidade reenvia; a situação fica; o aviso sai no envio',
  async () => {
    const doc = await newInvoice('falha-pendente');
    const v2Id = await correctWithFailedSend(doc, 'falha-pendente');

    assert.equal(financeStatus(v2Id), 'PENDING_APPROVAL');
    assert.equal(invoiceRow(v2Id, `"costCenterCode"`), '201');

    // O dono não troca a conta nem o centro de um rascunho que a Contabilidade corrigiu.
    const lockedCenter = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setCostCenter', {
      envelopeId: v2Id,
      code: '401',
    });

    assert.equal(lockedCenter.status, 403, lockedCenter.text);

    const lockedChoice = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
      envelopeId: v2Id,
      choice: { code: '3.1.01' },
    });

    assert.equal(lockedChoice.status, 403, lockedChoice.text);
    assert.equal(invoiceRow(v2Id, `"costCenterCode" || '|' || "choiceCode"`), '201|2.1.03');

    // O bloco do envio libera o rascunho para quem é dono.
    const state = data(await trpcAs(userCookie, 'query', 'revalle.invoice.get', { envelopeId: v2Id }));

    assert.equal(state.isFinanceSendReleased, true, 'o bloco do envio não libera o rascunho');
    assert.equal(data(await card(v2Id)).envelopeStatus, 'DRAFT');

    // Sem envio, sem aviso: não há link para dar.
    await sleep(2000);
    assert.deepEqual(
      (await mailsTo(user.email)).filter((m) => m.Subject === NOTICE_SUBJECT(doc.title)),
      [],
    );

    // 2ª falha: nada muda.
    const again = await resend(v2Id);

    assert.ok(again.status >= 400 && again.status < 500, again.text);
    assert.equal(status(v2Id), 'DRAFT');
    assert.equal(financeStatus(v2Id), 'PENDING_APPROVAL');

    assert.equal((await resend(v2Id, outsider.cookie)).status, 403);
    assert.equal((await resend(v2Id, userCookie)).status, 403);

    fixRecipient(v2Id, 'falha-pendente');

    const sent = await resend(v2Id);

    assert.equal(sent.status, 200, sent.text);
    assert.deepEqual(data(sent), { sent: true });
    assert.equal(await waitStatus(v2Id, 'PENDING', 15), 'PENDING');
    assert.equal(financeStatus(v2Id), 'PENDING_APPROVAL');
    assert.deepEqual(data(await resend(v2Id)), { sent: false });

    const notices = await waitMails(user.email, (m) => m.Subject === NOTICE_SUBJECT(doc.title));

    assert.equal(notices.length, 1, 'o aviso não saiu depois do envio');
    assert.ok(flat((await mailBody(notices[0].ID)).Text).includes(NOTICE_LINE));
  },
);

sessionTest(
  'falha no envio com a NF aprovada: o Financeiro reenvia sem mexer na aprovação copiada; clique duplo envia uma vez',
  async () => {
    const doc = await newInvoice('falha-aprovada');

    assert.equal((await approve(doc.id)).status, 200);

    const approval = invoiceRow(doc.id, COPIED_APPROVAL);
    const v2Id = await correctWithFailedSend(doc, 'falha-aprovada');

    assert.equal(financeStatus(v2Id), 'APPROVED');
    assert.equal(invoiceRow(v2Id, COPIED_APPROVAL), approval, 'a falha no envio soltou a aprovação copiada');

    const failed = await resend(v2Id, adminCookie);

    assert.ok(failed.status >= 400 && failed.status < 500, failed.text);
    assert.equal(invoiceRow(v2Id, COPIED_APPROVAL), approval, 'a 2ª falha mexeu na aprovação copiada');

    const email = fixRecipient(v2Id, 'falha-aprovada');
    const results = await Promise.all([resend(v2Id, adminCookie), resend(v2Id)]);
    const texts = results.map((r) => r.text).join('\n');

    assert.ok(
      results.every((r) => r.status === 200),
      texts,
    );
    assert.deepEqual(results.map((r) => data(r).sent).sort(), [false, true], texts);
    assert.equal(await waitStatus(v2Id, 'PENDING', 15), 'PENDING');
    assert.equal(auditCount(v2Id, 'DOCUMENT_SENT'), 1, 'o documento foi enviado duas vezes');
    assert.equal(invoiceRow(v2Id, COPIED_APPROVAL), approval, 'o reenvio mexeu na aprovação copiada');

    const notices = await waitMails(email, (m) => m.Subject === NOTICE_SUBJECT(doc.title));

    assert.equal(notices.length, 1);
  },
);

sessionTest('falha no envio: o dono corrige o rascunho e envia, sem mexer na aprovação copiada', async () => {
  const doc = await newInvoice('falha-dono');

  assert.equal((await approve(doc.id)).status, 200);

  const approval = invoiceRow(doc.id, COPIED_APPROVAL);
  const v2Id = await correctWithFailedSend(doc, 'falha-dono');

  fixRecipient(v2Id, 'falha-dono');

  const sent = await api('POST', '/envelope/distribute', { envelopeId: v2Id });

  assert.equal(sent.status, 200, sent.text);
  assert.equal(await waitStatus(v2Id, 'PENDING', 15), 'PENDING');
  assert.equal(financeStatus(v2Id), 'APPROVED');
  assert.equal(invoiceRow(v2Id, COPIED_APPROVAL), approval);
});

sessionTest(
  'rascunho de nova versão: Financeiro e Contabilidade abrem e listam; o rascunho comum fica escondido',
  async () => {
    const pending = await newInvoice('rascunho-pendente');
    const pendingV2 = await correctWithFailedSend(pending, 'rascunho-pendente');

    const approved = await newInvoice('rascunho-aprovado');

    assert.equal((await approve(approved.id)).status, 200);

    const approvedV2 = await correctWithFailedSend(approved, 'rascunho-aprovado');

    for (const envelopeId of [pendingV2, approvedV2]) {
      assert.equal(status(envelopeId), 'DRAFT');

      for (const cookie of [accountant.cookie, financeOnly.cookie]) {
        assert.equal(
          (await invoicePage(cookie, envelopeId)).status,
          200,
          'a página do rascunho da nova versão não abre',
        );
      }

      const financeView = await financeCard(envelopeId, financeOnly.cookie);

      assert.equal(financeView.status, 200, financeView.text);
      assert.equal((await invoicePage(outsider.cookie, envelopeId)).status, 404);
    }

    for (const cookie of [accountant.cookie, financeOnly.cookie]) {
      const ids = (await findRows(cookie)).map((row) => row.id);

      assert.ok(ids.includes(pendingV2), 'a lista não mostra o rascunho em PENDING_APPROVAL');
      assert.ok(ids.includes(approvedV2), 'a lista não mostra o rascunho em APPROVED');
    }

    assert.ok(!(await findRows(outsider.cookie)).some((row) => row.id === pendingV2), 'o terceiro vê o rascunho');

    // O rascunho comum continua de quem criou, mesmo com o estado que um envio que falhou no meio pode deixar.
    const plain = await newInvoice('rascunho-comum', { send: false });

    for (const forced of ['null', `'PENDING_APPROVAL'`, `'APPROVED'`]) {
      db(`update "RevalleInvoiceClassification" set "financeStatus" = ${forced} where "envelopeId" = '${plain.id}'`);

      for (const cookie of [accountant.cookie, financeOnly.cookie]) {
        assert.equal((await invoicePage(cookie, plain.id)).status, 404, `página com ${forced}`);
        assert.ok(!(await findRows(cookie)).some((row) => row.id === plain.id), `lista com ${forced}`);
      }

      assert.equal((await card(plain.id)).status, 404, `cartão da Contabilidade com ${forced}`);
      assert.equal((await financeCard(plain.id, financeOnly.cookie)).status, 404, `cartão do Financeiro com ${forced}`);

      // O admin, também do Financeiro, abre o rascunho comum na leitura, sem o cartão, cuja rota daria 404.
      const adminPage = await invoicePage(adminCookie, plain.id);

      assert.equal(adminPage.status, 200);
      assert.ok(adminPage.text.includes('invoice-view-cost-center'), `leitura para o admin com ${forced}`);
    }
  },
);

sessionTest(
  'arquivo trocado no rascunho da v2: perde a isenção, o envio exige a conta e o centro, e a validação cai',
  async () => {
    const doc = await newInvoiceWithTwoFiles('arquivo-trocado');
    const v2Id = await correctWithFailedSend(doc, 'arquivo-trocado');

    fixRecipient(v2Id, 'arquivo-trocado');
    assert.equal(invoiceRow(v2Id, VALIDATION), `${accountant.id}|${accountant.name}|true`);

    const items = (await api('GET', `/envelope/${v2Id}`)).body.envelopeItems;
    const example = items.find((item) => item.title.startsWith('example'));

    assert.ok(example, JSON.stringify(items.map((item) => item.title)));

    const removed = await api('POST', '/envelope/item/delete', { envelopeId: v2Id, envelopeItemId: example.id });

    assert.equal(removed.status, 200, removed.text);

    const cleared = data(await trpcAs(userCookie, 'mutation', 'revalle.invoice.classify', { envelopeId: v2Id }));

    assert.equal(cleared.isInvoice, 'YES');
    assert.equal(cleared.choice, null);
    assert.equal(cleared.costCenter, null);
    assert.equal(cleared.financeStatus, null);
    assert.equal(invoiceRow(v2Id, VALIDATION), '-|-|false', 'a validação ficou num rascunho com outro arquivo');

    // Só com a conta (a escolha volta a ser do dono): o envio pela API recusa, e a recusa não deixa o documento sair.
    const chosen = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
      envelopeId: v2Id,
      choice: { code: '2.1.03' },
    });

    assert.equal(chosen.status, 200, chosen.text);

    const withoutCenter = await api('POST', '/envelope/distribute', { envelopeId: v2Id });

    assert.equal(withoutCenter.status, 400, withoutCenter.text);
    assert.ok(withoutCenter.text.includes('INVOICE_ACCOUNT_REQUIRED'), withoutCenter.text);
    assert.equal(status(v2Id), 'DRAFT');

    const center = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setCostCenter', {
      envelopeId: v2Id,
      code: '401',
    });

    assert.equal(center.status, 200, center.text);

    const sent = await api('POST', '/envelope/distribute', { envelopeId: v2Id });

    assert.equal(sent.status, 200, sent.text);
    assert.equal(financeStatus(v2Id), 'PENDING_APPROVAL');
  },
);

sessionTest('setCostCenter recusa a versão substituída: a nova versão é que vale', async () => {
  const doc = await newInvoice('sem-centro-substituida');

  db(
    `update "RevalleInvoiceClassification" set "costCenterCode" = null, "costCenterById" = null, "costCenterAt" = null where "envelopeId" = '${doc.id}'`,
  );
  changed(await changeAccount(doc.id));

  const res = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setCostCenter', {
    envelopeId: doc.id,
    code: '201',
  });

  assert.ok(res.status === 400 || res.status === 403, res.text);
  assert.ok(errorOf(res).message?.includes(SUPERSEDED_MESSAGE), res.text);
  assert.equal(invoiceRow(doc.id, `coalesce("costCenterCode", '-')`), '-');
});

sessionTest('falha ao criar a v2 (cota zerada): a correção é desfeita, sem marca nem cópia', async () => {
  const doc = await newInvoice('cota');
  const claimId = db(
    `select o."organisationClaimId" from "Envelope" e join "Team" t on t.id = e."teamId" join "Organisation" o on o.id = t."organisationId" where e.id = '${doc.id}'`,
  );
  const previousQuota = db(
    `select coalesce("documentQuota"::text, 'null') from "OrganisationClaim" where id = '${claimId}'`,
  );

  db(`update "OrganisationClaim" set "documentQuota" = 0 where id = '${claimId}'`);

  try {
    const res = await correct(doc.id);

    assert.ok(!res.ok, `a correção passou com a cota zerada: ${res.text}`);
  } finally {
    db(`update "OrganisationClaim" set "documentQuota" = ${previousQuota} where id = '${claimId}'`);
  }

  assert.equal(
    invoiceRow(
      doc.id,
      `"financeStatus" || '|' || ("supersedeKind" is null) || '|' || ("supersededAt" is null) || '|' || ("supersedeReason" is null)`,
    ),
    'PENDING_APPROVAL|true|true|true',
  );
  assert.deepEqual(successors(doc.id), []);
  assert.equal(auditCount(doc.id, 'REVALLE_COST_CENTER_CHANGED'), 0);
  assert.equal(db(`select "deletedAt" is null from "Envelope" where id = '${doc.id}'`), 't');
});

sessionTest(
  'correção que morreu no meio: 409 no prazo, o Financeiro recebe "A situação mudou"; depois do prazo, retoma com a situação certa',
  async () => {
    const mark = (envelopeId, age) =>
      db(
        `update "RevalleInvoiceClassification" set "financeStatus" = 'SUPERSEDED', "supersedeKind" = 'COST_CENTER', "supersededAt" = now() - interval '${age}', "supersededById" = ${accountant.id}, "supersedeReason" = 'Queda no meio da correção.' where "envelopeId" = '${envelopeId}'`,
      );

    const pending = await newInvoice('retomada-pendente');

    mark(pending.id, '10 seconds');

    const early = await correct(pending.id);

    assert.equal(early.status, 409, early.text);

    const otherKind = await changeAccount(pending.id);

    refused(otherKind, STATE_CHANGED);
    assert.deepEqual(successors(pending.id), []);

    mark(pending.id, '10 minutes');

    const pendingV2 = changed(await correct(pending.id));

    assert.equal(financeStatus(pendingV2), 'PENDING_APPROVAL', 'a retomada aprovou uma NF sem aprovação');
    assert.equal(invoiceRow(pending.id, '"supersededByEnvelopeId"'), pendingV2);
    assert.equal(invoiceRow(pending.id, '"supersedeReason"'), REASON);

    // A aprovação continua na linha marcada: a retomada a leva para a nova versão.
    const approved = await newInvoice('retomada-aprovada');

    assert.equal((await approve(approved.id)).status, 200);

    const approval = invoiceRow(approved.id, COPIED_APPROVAL);

    mark(approved.id, '10 minutes');

    const approvedV2 = changed(await correct(approved.id));

    assert.equal(financeStatus(approvedV2), 'APPROVED');
    assert.equal(invoiceRow(approvedV2, COPIED_APPROVAL), approval);
  },
);
