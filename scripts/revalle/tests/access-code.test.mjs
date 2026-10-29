// Código por e-mail sempre exigido (Task 8, Fase 3). Rodam contra a stack local.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  api,
  completeWithCode,
  computeEmailCode,
  createEnvelope,
  db,
  distribute,
  getLatestCode,
  latestMail,
  signIn,
  trpc,
  trpcAs,
} from './helpers.mjs';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const OWNER_EMAIL = 'admin@hml.local';
const ADMIN_NOTICE_EMAIL = 'teste1@revalle.com.br';
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unique = (tag) => `code-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@revalle.com.br`;

const passGate = async (token) => {
  assert.equal((await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' })).status, 200);

  const verified = await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });

  assert.equal(verified.body?.result?.data?.json?.status, 'IDENTITY_CONFIRM', verified.text);

  const confirmed = await trpc('revalle.gate.confirmIdentity', { token, isMe: true });

  assert.equal(confirmed.body?.result?.data?.json?.status, 'PASSED', confirmed.text);
};

const setup = async ({ recipient: extra = {}, tamper, email = unique('r') } = {}) => {
  const created = await createEnvelope({ recipients: [{ email, ...extra }] });

  assert.equal(created.status, 200, created.text);

  tamper?.(created);

  const [recipient] = await distribute(created.id);
  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const field = created.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');

  await passGate(recipient.token);

  const signed = await trpc('envelope.field.sign', {
    token: recipient.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Teste' },
  });

  assert.equal(signed.status, 200, signed.text);

  return { id: created.id, recipient, documentId };
};

beforeEach(() => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
});

test('o envelope criado sem autenticação sai com o código por e-mail exigido', async () => {
  const created = await createEnvelope({ recipients: [{ email: unique('auth') }] });

  assert.equal(created.status, 200, created.text);
  assert.deepEqual(
    db(`select "authOptions"->'globalAccessAuth' from "Envelope" where id = '${created.id}'`).replace(/\s/g, ''),
    '["TWO_FACTOR_AUTH"]',
  );

  await distribute(created.id);

  assert.match(db(`select "authOptions"::text from "Envelope" where id = '${created.id}'`), /TWO_FACTOR_AUTH/);
});

const noCode = (s) =>
  trpc('recipient.completeDocumentWithToken', { token: s.recipient.token, documentId: s.documentId });

test('o backstop do envio recoloca o código apagado; sem código a conclusão é recusada, com código passa', async () => {
  const s = await setup({
    tamper: (c) =>
      db(`update "Envelope" set "authOptions" = '{"globalAccessAuth":[],"globalActionAuth":[]}' where id = '${c.id}'`),
  });

  assert.match(db(`select "authOptions"::text from "Envelope" where id = '${s.id}'`), /TWO_FACTOR_AUTH/);
  assert.notEqual((await noCode(s)).status, 200);

  const done = await completeWithCode({ token: s.recipient.token, documentId: s.documentId, email: s.recipient.email });

  assert.equal(done.status, 200, done.text);
});

test('accessAuth do destinatário sem código é corrigido no envio e a conclusão exige o código', async () => {
  const created = await createEnvelope({ recipients: [{ email: unique('acc'), accessAuth: ['ACCOUNT'] }] });

  assert.equal(created.status, 200, created.text);
  assert.match(
    db(`select "authOptions"::text from "Recipient" where "envelopeId" = '${created.id}'`),
    /TWO_FACTOR_AUTH/,
  );
});

test('override gravado direto no banco (accessAuth ACCOUNT): o envio corrige e sem código é recusado', async () => {
  const s = await setup({
    tamper: (c) =>
      db(
        `update "Recipient" set "authOptions" = '{"accessAuth":["ACCOUNT"],"actionAuth":[]}' where "envelopeId" = '${c.id}'`,
      ),
  });

  assert.match(db(`select "authOptions"::text from "Recipient" where id = ${s.recipient.id}`), /TWO_FACTOR_AUTH/);
  assert.notEqual((await noCode(s)).status, 200);
});

test('override com lista vazia no banco depois do envio: a conclusão ainda exige o código', async () => {
  const s = await setup();

  db(`update "Envelope" set "authOptions" = '{"globalAccessAuth":[],"globalActionAuth":[]}' where id = '${s.id}'`);
  db(
    `update "Recipient" set "authOptions" = '{"accessAuth":["ACCOUNT"],"actionAuth":[]}' where id = ${s.recipient.id}`,
  );

  assert.notEqual((await noCode(s)).status, 200);
  assert.equal(db(`select "signingStatus" from "Recipient" where id = ${s.recipient.id}`), 'NOT_SIGNED');

  const done = await completeWithCode({ token: s.recipient.token, documentId: s.documentId, email: s.recipient.email });

  assert.equal(done.status, 200, done.text);
});

test('concluir sem código ou com código errado é recusado', async () => {
  const s = await setup();
  const none = await trpc('recipient.completeDocumentWithToken', {
    token: s.recipient.token,
    documentId: s.documentId,
  });

  assert.notEqual(none.status, 200, none.text);

  const wrong = await trpc('recipient.completeDocumentWithToken', {
    token: s.recipient.token,
    documentId: s.documentId,
    accessAuthOptions: { type: 'TWO_FACTOR_AUTH', method: 'email', token: '000000' },
  });

  assert.notEqual(wrong.status, 200, wrong.text);
  assert.equal(db(`select "signingStatus" from "Recipient" where id = ${s.recipient.id}`), 'NOT_SIGNED');
});

test('com o código do e-mail conclui, e os eventos do código trazem IP e navegador', async () => {
  const s = await setup();
  const done = await completeWithCode({
    token: s.recipient.token,
    documentId: s.documentId,
    email: s.recipient.email,
  });

  assert.equal(done.status, 200, done.text);
  assert.ok(await getLatestCode(s.recipient.email));

  for (let i = 0; i < 60; i += 1) {
    if ((await api('GET', `/envelope/${s.id}`)).body.status === 'COMPLETED') {
      break;
    }

    await sleep(3000);
  }

  assert.equal((await api('GET', `/envelope/${s.id}`)).body.status, 'COMPLETED');

  for (const type of ['DOCUMENT_ACCESS_AUTH_2FA_REQUESTED', 'DOCUMENT_ACCESS_AUTH_2FA_VALIDATED']) {
    const row = db(
      `select coalesce("ipAddress",''), coalesce("userAgent",'') from "DocumentAuditLog" where "envelopeId" = '${s.id}' and type = '${type}'`,
    );

    assert.match(row, /^203\.0\.113\.7\|revsign-gate-test$/, `${type}: ${row}`);
  }
});

// --- Revisão final (C1/C2): só o código por e-mail vale, e código errado tem limite. ---

const complete = (s, accessAuthOptions, headers = {}) =>
  trpc(
    'recipient.completeDocumentWithToken',
    { token: s.recipient.token, documentId: s.documentId, ...(accessAuthOptions ? { accessAuthOptions } : {}) },
    headers,
  );

const requestCode = async (s) => {
  const before = await getLatestCode(s.recipient.email);

  assert.equal((await trpc('document.accessAuth.request2FAEmail', { token: s.recipient.token })).status, 200);

  for (let i = 0; i < 30; i += 1) {
    const code = await getLatestCode(s.recipient.email);

    if (code && code !== before) {
      return code;
    }

    await sleep(300);
  }

  throw new Error('código não chegou no Mailpit');
};

const gateRow = (s) =>
  db(
    `select "codeFailedAttempts" || '|' || coalesce("lockReason",'') || '|' || ("lockedAt" is not null) from "RevalleRecipientGate" where "recipientId" = ${s.recipient.id}`,
  );

test('C1: método autenticador (mesmo com o código certo) e ACCOUNT são recusados; o código por e-mail conclui', async () => {
  const s = await setup();
  const code = await requestCode(s);

  const authenticator = await complete(s, { type: 'TWO_FACTOR_AUTH', method: 'authenticator', token: code });

  assert.notEqual(authenticator.status, 200, authenticator.text);

  const noMethod = await complete(s, { type: 'TWO_FACTOR_AUTH', token: code });

  assert.notEqual(noMethod.status, 200, noMethod.text);

  const account = await complete(s, { type: 'ACCOUNT' });

  assert.notEqual(account.status, 200, account.text);
  assert.equal(db(`select "signingStatus" from "Recipient" where id = ${s.recipient.id}`), 'NOT_SIGNED');
  assert.equal(gateRow(s), '3||false');

  const done = await complete(s, { type: 'TWO_FACTOR_AUTH', method: 'email', token: code });

  assert.equal(done.status, 200, done.text);
  assert.equal(gateRow(s), '0||false');
});

test(
  'C1: ACCOUNT com sessão do próprio destinatário (authOptions com ACCOUNT) não substitui o código',
  admin.email && admin.password ? {} : { skip: 'REVSIGN_ADMIN_EMAIL/PASSWORD não informados' },
  async () => {
    // O destinatário é uma conta existente; com ACCOUNT no authOptions, o upstream aceitaria a sessão dela no lugar do código.
    db(`delete from "RevalleEmailLink" where email = '${admin.email}'`);

    const s = await setup({ email: admin.email });

    db(
      `update "Recipient" set "authOptions" = '{"accessAuth":["ACCOUNT","TWO_FACTOR_AUTH"],"actionAuth":[]}' where id = ${s.recipient.id}`,
    );

    const cookie = await signIn(admin.email, admin.password);
    const account = await complete(s, { type: 'ACCOUNT' }, { Cookie: cookie });

    assert.notEqual(account.status, 200, account.text);

    const viaSession = await trpcAs(cookie, 'mutation', 'recipient.completeDocumentWithToken', {
      token: s.recipient.token,
      documentId: s.documentId,
      accessAuthOptions: { type: 'ACCOUNT' },
    });

    assert.notEqual(viaSession.status, 200, viaSession.text);
    assert.equal(db(`select "signingStatus" from "Recipient" where id = ${s.recipient.id}`), 'NOT_SIGNED');

    const done = await completeWithCode({
      token: s.recipient.token,
      documentId: s.documentId,
      email: s.recipient.email,
      headers: { Cookie: cookie },
    });

    assert.equal(done.status, 200, done.text);
    db(`delete from "RevalleEmailLink" where email = '${admin.email}'`);
  },
);

test('C2: 5 códigos errados bloqueiam o link (CODE_ATTEMPTS), avisam dono e admin; o código certo depois é recusado', async () => {
  const s = await setup();

  for (let i = 1; i <= 5; i += 1) {
    const wrong = await complete(s, { type: 'TWO_FACTOR_AUTH', method: 'email', token: '000000' });

    assert.notEqual(wrong.status, 200, wrong.text);
  }

  assert.equal(gateRow(s), '5|CODE_ATTEMPTS|true');
  assert.equal(
    (await trpc('revalle.gate.acceptTerm', { token: s.recipient.token, termVersion: '1' })).body.result.data.json
      .status,
    'LOCKED',
  );
  assert.match(
    db(`select data::text from "DocumentAuditLog" where "envelopeId" = '${s.id}' and type = 'REVALLE_GATE_LOCKED'`),
    /CODE_ATTEMPTS/,
  );

  await sleep(1500);

  for (const to of [OWNER_EMAIL, ADMIN_NOTICE_EMAIL]) {
    const mail = await latestMail(to);

    assert.ok(mail, `sem e-mail para ${to}`);
    assert.match(mail.Subject, /Link de assinatura bloqueado/);
    assert.ok(mail.HTML.includes(s.recipient.email));
    assert.match(mail.Text, /código enviado por e-mail foi digitado errado 5 vezes/);
  }

  const afterLock = await completeWithCode({
    token: s.recipient.token,
    documentId: s.documentId,
    email: s.recipient.email,
  });

  assert.notEqual(afterLock.status, 200, afterLock.text);
  assert.equal(db(`select "signingStatus" from "Recipient" where id = ${s.recipient.id}`), 'NOT_SIGNED');
  assert.equal(gateRow(s), '5|CODE_ATTEMPTS|true');

  if (admin.email && admin.password) {
    const cookie = await signIn(admin.email, admin.password);
    const gateId = db(`select id from "RevalleRecipientGate" where "recipientId" = ${s.recipient.id}`);
    const list = (await trpcAs(cookie, 'query', 'revalle.admin.findGates', { type: 'LOCKED' })).body.result.data.json;

    assert.equal(list.locked.find((item) => item.id === gateId)?.reason, 'CODE_ATTEMPTS');
    assert.equal((await trpcAs(cookie, 'mutation', 'revalle.admin.unlockGate', { gateId })).status, 200);
    assert.equal(gateRow(s), '0||false');

    const unlocked = await completeWithCode({
      token: s.recipient.token,
      documentId: s.documentId,
      email: s.recipient.email,
    });

    assert.equal(unlocked.status, 200, unlocked.text);
  }
});

test('C2: código vencido (fora dos 5 minutos) é recusado e conta tentativa; o código atual conclui e zera', async () => {
  const s = await setup();

  await requestCode(s);

  // O código é calculado dentro do container (mesma chave do app) para um período de 6 minutos atrás.
  const expired = computeEmailCode({ email: s.recipient.email, envelopeId: s.id, periodsAgo: 12 });
  const refused = await complete(s, { type: 'TWO_FACTOR_AUTH', method: 'email', token: expired });

  assert.notEqual(refused.status, 200, refused.text);
  assert.equal(gateRow(s), '1||false');

  const current = computeEmailCode({ email: s.recipient.email, envelopeId: s.id, periodsAgo: 0 });
  const done = await complete(s, { type: 'TWO_FACTOR_AUTH', method: 'email', token: current });

  assert.equal(done.status, 200, done.text);
  assert.equal(gateRow(s), '0||false');
});

test('revalle.complete: no máximo 20 conclusões por link em 15 min', async () => {
  const s = await setup();

  for (let i = 0; i < 20; i += 1) {
    const res = await complete(s);

    assert.equal(res.status, 401, res.text);
  }

  const limited = await complete(s);

  assert.equal(limited.status, 429, limited.text);
  assert.equal(gateRow(s), '0||false');
});

test('request2FAEmail: nunca para CC, nem para quem já concluiu, nem em documento não pendente', async () => {
  const created = await createEnvelope({
    recipients: [
      { email: unique('cc'), role: 'CC', fields: [] },
      { email: unique('viewer'), role: 'VIEWER', fields: [] },
      { email: unique('signer') },
    ],
  });

  assert.equal(created.status, 200, created.text);

  const recipients = await distribute(created.id);
  const byRole = (role) => recipients.find((r) => r.role === role);

  assert.equal((await trpc('document.accessAuth.request2FAEmail', { token: byRole('CC').token })).status, 404);

  // VIEWER pede o código para "marcar como visto" (a tela do upstream exige); depois de concluir, não pede mais.
  assert.equal((await trpc('document.accessAuth.request2FAEmail', { token: byRole('VIEWER').token })).status, 200);
  db(`update "Recipient" set "signingStatus" = 'SIGNED' where id = ${byRole('VIEWER').id}`);
  assert.equal((await trpc('document.accessAuth.request2FAEmail', { token: byRole('VIEWER').token })).status, 404);

  assert.equal((await trpc('document.accessAuth.request2FAEmail', { token: byRole('SIGNER').token })).status, 200);

  db(`update "Recipient" set "signingStatus" = 'SIGNED' where id = ${byRole('SIGNER').id}`);
  assert.equal((await trpc('document.accessAuth.request2FAEmail', { token: byRole('SIGNER').token })).status, 404);

  const draft = await createEnvelope({ recipients: [{ email: unique('draft') }] });
  const draftToken = db(`select token from "Recipient" where "envelopeId" = '${draft.id}'`);

  assert.equal((await trpc('document.accessAuth.request2FAEmail', { token: draftToken })).status, 404);
});

// --- Fase 4, Task 0: pendências herdadas da Fase 3. ---

test('stuck-at-5: contador em 5 sem bloqueio (requisição caiu antes de bloquear) vira LOCKED/CODE_ATTEMPTS', async () => {
  const s = await setup();

  db(
    `update "RevalleRecipientGate" set "codeFailedAttempts" = 5, "lockedAt" = null, "lockReason" = null where "recipientId" = ${s.recipient.id}`,
  );

  const res = await completeWithCode({
    token: s.recipient.token,
    documentId: s.documentId,
    email: s.recipient.email,
  });

  assert.notEqual(res.status, 200, res.text);
  assert.equal(db(`select "signingStatus" from "Recipient" where id = ${s.recipient.id}`), 'NOT_SIGNED');
  assert.equal(gateRow(s), '5|CODE_ATTEMPTS|true');

  if (admin.email && admin.password) {
    const cookie = await signIn(admin.email, admin.password);
    const gateId = db(`select id from "RevalleRecipientGate" where "recipientId" = ${s.recipient.id}`);
    const list = (await trpcAs(cookie, 'query', 'revalle.admin.findGates', { type: 'LOCKED' })).body.result.data.json;

    assert.equal(list.locked.find((item) => item.id === gateId)?.reason, 'CODE_ATTEMPTS');
  }
});

test('email-change-resets-code-attempts: trocar o e-mail zera os códigos errados; o bloqueio existente continua', async () => {
  const s = await setup();

  for (let i = 0; i < 3; i += 1) {
    const wrong = await complete(s, { type: 'TWO_FACTOR_AUTH', method: 'email', token: '000000' });

    assert.notEqual(wrong.status, 200, wrong.text);
  }

  assert.equal(gateRow(s), '3||false');

  db(`update "Recipient" set email = '${unique('novo')}' where id = ${s.recipient.id}`);
  await trpc('revalle.gate.acceptTerm', { token: s.recipient.token, termVersion: '1' });

  assert.equal(gateRow(s), '0||false');

  // Bloqueio existente persiste na troca de e-mail.
  db(
    `update "RevalleRecipientGate" set "codeFailedAttempts" = 4, "lockedAt" = now(), "lockReason" = 'CODE_ATTEMPTS' where "recipientId" = ${s.recipient.id}`,
  );
  db(`update "Recipient" set email = '${unique('novo2')}' where id = ${s.recipient.id}`);
  await trpc('revalle.gate.acceptTerm', { token: s.recipient.token, termVersion: '1' });

  assert.equal(gateRow(s), '0|CODE_ATTEMPTS|true');
});
