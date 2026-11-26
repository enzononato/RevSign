// "Apenas assinar" (sem validação do financeiro): a escolha do topo do diálogo de envio usa as rotas de sempre
// (`revalle.invoice.setInvoiceFlag`, o "Não é nota fiscal" / "Sim, é nota fiscal").
//   - (a) DANFE detectado como NF e marcado "Apenas assinar": sai sem conta e sem centro, não entra na fila do Financeiro
//     (nem `find` nem `pendingCounts`), nunca fica `PENDING_APPROVAL`, e quem assina conclui: o documento é selado sem
//     aprovação nenhuma;
//   - (b) o mesmo DANFE que volta para "Nota fiscal": o envio sem a conta e o centro continua recusado
//     (`INVOICE_ACCOUNT_REQUIRED`, também pela API v1), e com os dois sai `PENDING_APPROVAL` na fila do Financeiro.
//
// Sessões: REVSIGN_USER_* (admin@hml.local, dono do REVSIGN_API_TOKEN, fora do Financeiro) e REVSIGN_ADMIN_* (rsadmin,
// ADMIN, marcado como Financeiro aqui, como no finance-send). Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import './account-autologin.mjs'; // conta obrigatória (16/11/2026): entra na conta de quem assina pelo e-mail da empresa
import {
  api,
  assertNoPaidGeminiCalls,
  BASE_URL,
  chooseInvoice,
  completeWithCode,
  createEnvelope,
  danfePdfFile,
  db,
  ensureInvoiceAccounts,
  retryCreateOnStaleSocket,
  signIn,
  trpc,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const REQUIRED_MESSAGE = 'Escolha a conta contábil e o centro de custo.';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userCookie;
let adminCookie;

const data = (res) => res.body?.result?.data?.json;
const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);
const classification = (envelopeId) =>
  db(
    `select "isInvoice" || '|' || coalesce("financeStatus"::text, '-') from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`,
  );
const auditCount = (envelopeId, type) =>
  Number(db(`select count(*) from "DocumentAuditLog" where "envelopeId" = '${envelopeId}' and type = '${type}'`));

const invoiceMutation = async (procedure, input) => {
  const res = await trpcAs(userCookie, 'mutation', `revalle.invoice.${procedure}`, input);

  assert.equal(res.status, 200, res.text);

  return data(res);
};

// O que o diálogo faz ao abrir (classifica) e ao trocar a escolha do topo.
const classify = (envelopeId) => invoiceMutation('classify', { envelopeId });
const chooseSendKind = (envelopeId, kind) =>
  invoiceMutation('setInvoiceFlag', { envelopeId, isInvoice: kind === 'INVOICE' });

// A fila do Financeiro como o membro vê: o número do menu e a página "pendentes".
const financePending = async () => {
  const counts = await trpcAs(adminCookie, 'query', 'revalle.invoice.pendingCounts');
  const found = await trpcAs(adminCookie, 'query', 'revalle.invoice.find', { perPage: 100, finance: 'pendentes' });

  assert.equal(counts.status, 200, counts.text);
  assert.equal(found.status, 200, found.text);

  return { count: data(counts).finance, ids: new Set(data(found).data.map((row) => row.id)) };
};

const waitStatus = async (envelopeId, wanted, attempts = 45) => {
  for (let i = 0; i < attempts && status(envelopeId) !== wanted; i += 1) {
    await sleep(2000);
  }

  return status(envelopeId);
};

// DANFE (detectado como NF pelo texto) com um signatário da empresa, em rascunho.
const newDanfeDraft = async (label) => {
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({
      recipients: [{ email: `apenas-assinar-${label}-${RUN}@revalle.com.br` }],
      pdf: danfePdfFile(`apenas-assinar ${label} ${RUN}`),
      title: `[TESTE NF] apenas assinar ${label} ${RUN}`,
    }),
  );

  assert.equal(created.status, 200, created.text);

  return {
    id: created.id,
    documentId: Number.parseInt(created.envelope.secondaryId.split('_')[1], 10),
    secondaryId: created.envelope.secondaryId,
    fields: created.envelope.fields,
  };
};

const gate = async (token) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

// Portão, assinatura e conclusão com o código, como em finance-approve.
const sign = async (doc, recipient) => {
  const field = doc.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');

  await gate(recipient.token);

  const signed = await trpc('envelope.field.sign', {
    token: recipient.token,
    fieldId: field.id,
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

  // O membro do Financeiro é o rsadmin; o usuário comum nunca é.
  const adminId = Number(db(`select id from "User" where email = '${admin.email}'`));
  const marked = await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', {
    userId: adminId,
    member: true,
  });

  assert.equal(marked.status, 200, marked.text);
  db(`delete from "RevalleFinanceMember" where "userId" = (select id from "User" where email = '${user.email}')`);

  await ensureInvoiceAccounts(adminCookie);
  db(`delete from "RateLimit" where action like 'revalle.invoice%'`);
});

sessionTest(
  '(a) NF detectada marcada "Apenas assinar": sai sem conta nem centro, fora do Financeiro, e conclui sem aprovação',
  async () => {
    const doc = await newDanfeDraft('so-assinar');

    // O diálogo abre com "Nota fiscal" marcado: foi o que o sistema detectou.
    assert.equal((await classify(doc.id)).isInvoice, 'YES');

    const signOnly = await chooseSendKind(doc.id, 'SIGN_ONLY');

    assert.equal(signOnly.isInvoice, 'NO');
    assert.equal(signOnly.detectedBy, 'SENDER');
    assert.equal(signOnly.choice, null);
    assert.equal(signOnly.costCenter, null);

    const before = await financePending();
    const sent = await api('POST', '/envelope/distribute', { envelopeId: doc.id });

    assert.equal(sent.status, 200, sent.text);
    assert.equal(status(doc.id), 'PENDING');
    // A classificação do envio ficou "não é NF" (os arquivos não mudaram) e nunca entrou no Financeiro.
    assert.equal(classification(doc.id), 'NO|-');

    const after = await financePending();

    assert.equal(after.count, before.count, 'o envio "Apenas assinar" entrou na contagem do Financeiro');
    assert.ok(!after.ids.has(doc.id), 'o envio "Apenas assinar" apareceu na fila do Financeiro');

    // Quem assina conclui: o documento é selado sem aprovação nenhuma.
    await sign(doc, sent.body.recipients[0]);

    assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED', 'o documento "Apenas assinar" ficou retido');
    assert.equal(classification(doc.id), 'NO|-');
    assert.equal(auditCount(doc.id, 'DOCUMENT_COMPLETED'), 1);
    assert.equal(
      db(`select count(*) from "DocumentAuditLog" where "envelopeId" = '${doc.id}' and type like 'REVALLE_FINANCE%'`),
      '0',
    );
    assert.equal((await financePending()).count, before.count);
  },
);

sessionTest(
  '(b) NF que volta para "Nota fiscal": sem conta e centro o envio é recusado; com os dois vai para o Financeiro',
  async () => {
    const doc = await newDanfeDraft('nota-fiscal');

    assert.equal((await classify(doc.id)).isInvoice, 'YES');
    // Troca para "Apenas assinar" e volta: a nota detectada volta a ser NF.
    assert.equal((await chooseSendKind(doc.id, 'SIGN_ONLY')).isInvoice, 'NO');
    assert.equal((await chooseSendKind(doc.id, 'INVOICE')).isInvoice, 'YES');

    const refused = await api('POST', '/envelope/distribute', { envelopeId: doc.id });

    assert.equal(refused.status, 400, refused.text);
    assert.ok(refused.text.includes('INVOICE_ACCOUNT_REQUIRED'), refused.text);
    assert.ok(refused.text.includes(REQUIRED_MESSAGE), refused.text);

    // A API v1 também não passa por cima (quem envia pela API não escolhe nada: vale a detecção, como sempre).
    const viaV1 = await fetch(`${BASE_URL}/api/v1/documents/${doc.secondaryId.replace(/\D/g, '')}/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    assert.equal(viaV1.status, 400, await viaV1.text());
    assert.equal(status(doc.id), 'DRAFT');
    assert.equal(classification(doc.id), 'YES|-');

    // Só a conta (sem o centro) ainda não sai.
    assert.equal((await chooseInvoice({ cookie: userCookie, envelopeId: doc.id, costCenter: null })).status, 200);
    assert.equal((await api('POST', '/envelope/distribute', { envelopeId: doc.id })).status, 400);

    assert.equal((await chooseInvoice({ cookie: userCookie, envelopeId: doc.id })).status, 200);

    const before = await financePending();
    const sent = await api('POST', '/envelope/distribute', { envelopeId: doc.id });

    assert.equal(sent.status, 200, sent.text);
    assert.equal(status(doc.id), 'PENDING');
    assert.equal(classification(doc.id), 'YES|PENDING_APPROVAL');

    const after = await financePending();

    assert.equal(after.count, before.count + 1, 'a NF não entrou na contagem do Financeiro');
    assert.ok(after.ids.has(doc.id), 'a NF não apareceu na fila do Financeiro');
  },
);
