// Autenticador na assinatura (v.26, Task 5). Rodam contra a stack local (revsign-hml).
//
// Quem está logado na própria conta (dona do e-mail do destinatário) e tem o app autenticador ligado conclui com o código
// do app no lugar do código por e-mail. Sem sessão, ou com outra conta, só o código por e-mail vale.
//
// O autenticador é ligado pelo fluxo do próprio app (rotas /api/auth/two-factor/setup e /enable) numa conta de teste nova;
// o código TOTP (RFC 6238) é calculado aqui com node:crypto. O segredo nunca é impresso.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';

import { ensureTestAccount, signInAs } from './account-helpers.mjs';
import { BASE_URL, completeWithCode, createEnvelope, db, distribute, trpc } from './helpers.mjs';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNER_EMAIL = `totp-${RUN}@revalle.com.br`;
const GMAIL = `totp-ext-${RUN}@gmail.com`;
const origin = new URL(BASE_URL).origin;

// --- RFC 6238 (TOTP, SHA-1, 6 dígitos, 30 s), como os apps autenticadores. ---

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32Decode = (input) => {
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];

  for (const char of clean) {
    const index = BASE32.indexOf(char);

    if (index < 0) {
      throw new Error('segredo base32 inválido');
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
};

const totp = (secret, periodsAgo = 0) => {
  const counter = Buffer.alloc(8);

  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) - periodsAgo));

  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;

  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};

// Um código que não é o de nenhum período aceito (atual e anterior) nem do seguinte.
const wrongTotp = (secret) => {
  const valid = new Set([totp(secret, -1), totp(secret, 0), totp(secret, 1)]);

  return ['000000', '111111', '222222', '333333'].find((code) => !valid.has(code));
};

// --- Conta de teste com o autenticador ligado pelo fluxo do app. ---

let ownerCookie;
let ownerSecret;
let ownerId;

const authPost = async (route, cookie, body) => {
  const res = await fetch(`${BASE_URL}/api/auth/two-factor/${route}`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  return { status: res.status, body: await res.json().catch(() => null) };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  ensureTestAccount(OWNER_EMAIL, 'Conta TOTP');
  ownerId = Number(db(`select id from "User" where email = '${OWNER_EMAIL}'`));
  // Login antes de ligar o autenticador: a sessão continua valendo depois.
  ownerCookie = await signInAs(OWNER_EMAIL);

  const setup = await authPost('setup', ownerCookie);

  assert.equal(setup.status, 200, 'setup do autenticador');
  assert.equal(typeof setup.body?.secret, 'string');
  ownerSecret = setup.body.secret;

  // A ativação do upstream aceita só o período atual: na virada dos 30 s, tenta de novo no período seguinte.
  let enabled = await authPost('enable', ownerCookie, { code: totp(ownerSecret) });

  if (enabled.status !== 200) {
    await sleep(2000);
    enabled = await authPost('enable', ownerCookie, { code: totp(ownerSecret) });
  }

  assert.equal(enabled.status, 200, 'ativação do autenticador');
  assert.equal(db(`select "twoFactorEnabled" from "User" where id = ${ownerId}`), 't');
});

beforeEach(() => {
  db('delete from "RateLimit"');
});

after(() => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
});

// --- Envelope com o portão passado e o campo assinado. ---

const gateStatus = (res) => res.body?.result?.data?.json?.status;

const prepare = async (email, cookie) => {
  const headers = cookie ? { Cookie: cookie } : {};
  const created = await createEnvelope({ recipients: [{ email }] });

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);
  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const field = created.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');

  const accepted = await trpc('revalle.gate.acceptTerm', { token: recipient.token, termVersion: '1' }, headers);

  assert.equal(accepted.status, 200, accepted.text);

  // E-mail da empresa já vinculado ao CPF (2º documento): o portão passa direto.
  if (gateStatus(accepted) !== 'PASSED') {
    const verified = await trpc('revalle.gate.verifyIdentity', { token: recipient.token, ...MARIA }, headers);

    assert.equal(gateStatus(verified), 'IDENTITY_CONFIRM', verified.text);

    const confirmed = await trpc('revalle.gate.confirmIdentity', { token: recipient.token, isMe: true }, headers);

    assert.equal(gateStatus(confirmed), 'PASSED', confirmed.text);
  }

  const signed = await trpc(
    'envelope.field.sign',
    { token: recipient.token, fieldId: field.id, fieldValue: { type: 'SIGNATURE', value: 'Teste' } },
    headers,
  );

  assert.equal(signed.status, 200, signed.text);

  return { id: created.id, recipient, documentId };
};

const completeWithAuthenticator = (s, code, headers = {}) =>
  trpc(
    'recipient.completeDocumentWithToken',
    {
      token: s.recipient.token,
      documentId: s.documentId,
      accessAuthOptions: { type: 'TWO_FACTOR_AUTH', method: 'authenticator', token: code },
    },
    headers,
  );

const attempts = (s) =>
  db(`select "codeFailedAttempts" from "RevalleRecipientGate" where "recipientId" = ${s.recipient.id}`);
const signingStatus = (s) => db(`select "signingStatus" from "Recipient" where id = ${s.recipient.id}`);
const validatedLog = (s) =>
  db(
    `select coalesce(data->>'revalleMethod', '-') || '|' || coalesce("userId"::text, '-') from "DocumentAuditLog" where "envelopeId" = '${s.id}' and type = 'DOCUMENT_ACCESS_AUTH_2FA_VALIDATED'`,
  );
const proofFactors = (s) =>
  db(
    `select string_agg(f->>'factor', ',') from "RevalleSignatureProof", jsonb_array_elements(factors) f where "recipientId" = ${s.recipient.id}`,
  );

test('dono do e-mail logado com o autenticador: código errado é recusado e conta tentativa; o certo conclui', async () => {
  const s = await prepare(OWNER_EMAIL, ownerCookie);
  const headers = { Cookie: ownerCookie };

  const wrong = await completeWithAuthenticator(s, wrongTotp(ownerSecret), headers);

  assert.notEqual(wrong.status, 200, wrong.text);
  assert.equal(signingStatus(s), 'NOT_SIGNED');
  assert.equal(attempts(s), '1');

  // Período anterior: não vira código "futuro" se o relógio voltar antes da conferência (ver helpers.mjs).
  const done = await completeWithAuthenticator(s, totp(ownerSecret, 1), headers);

  assert.equal(done.status, 200, done.text);
  assert.equal(signingStatus(s), 'SIGNED');
  assert.equal(attempts(s), '0');

  // Histórico: o evento traz o método e a conta que confirmou; a prova, o fator do autenticador no lugar do e-mail.
  assert.equal(validatedLog(s), `AUTHENTICATOR|${ownerId}`);
  assert.equal(proofFactors(s).split(',').includes('AUTHENTICATOR_CODE'), true, proofFactors(s));
  assert.equal(proofFactors(s).split(',').includes('EMAIL_CODE'), false, proofFactors(s));
});

test('sem sessão, ou com a sessão de outra conta: o autenticador é recusado e o código por e-mail conclui', async () => {
  // E-mail de fora da empresa: assina sem conta, então o pedido chega ao passo do código sem sessão.
  const s = await prepare(GMAIL);
  const code = totp(ownerSecret, 1);

  const noSession = await completeWithAuthenticator(s, code);

  assert.notEqual(noSession.status, 200, noSession.text);

  // A conta logada tem autenticador, mas não é a dona deste e-mail.
  const otherAccount = await completeWithAuthenticator(s, totp(ownerSecret, 1), { Cookie: ownerCookie });

  assert.notEqual(otherAccount.status, 200, otherAccount.text);
  assert.equal(signingStatus(s), 'NOT_SIGNED');
  assert.equal(attempts(s), '2');

  const done = await completeWithCode({ token: s.recipient.token, documentId: s.documentId, email: GMAIL });

  assert.equal(done.status, 200, done.text);
  assert.equal(validatedLog(s), '-|-');
  assert.equal(proofFactors(s).split(',').includes('EMAIL_CODE'), true, proofFactors(s));
  assert.equal(proofFactors(s).split(',').includes('AUTHENTICATOR_CODE'), false, proofFactors(s));
});
