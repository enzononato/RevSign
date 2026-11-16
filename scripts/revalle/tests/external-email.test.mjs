// E-mail externo (decisão de 16/11/2026): documento comum vai para qualquer e-mail, pela API v2 e pela tela (tRPC); nota
// fiscal continua só para e-mails da empresa (recusa no envio, ao marcar como NF e ao trocar destinatário de NF enviada);
// o cadastro continua só da empresa. Quem assina por um e-mail de fora passa SEMPRE por CPF + data de nascimento (o
// vínculo salvo não vale, as checagens de conflito não se aplicam e nenhum vínculo é criado); o e-mail da empresa segue
// como antes. Pessoas fictícias de revalle/colaboradores/dev-seed.sql.
//
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN) e REVSIGN_ADMIN_* (importa a lista de contas, se faltar a 2.1.03).
// Roda com a stack subida com compose.test.yml (servidor falso do Gemini): a NF passa pela sugestão.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

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
  distribute,
  ensureInvoiceAccounts,
  fetchIdempotent,
  postSignup,
  signIn,
  trpc,
  trpcAs,
} from './helpers.mjs';

assertNoPaidGeminiCalls();

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const gmail = (tag) => `ext-${tag}-${RUN}@gmail.com`;
const company = (tag) => `ext-${tag}-${RUN}@revalle.com.br`;

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
// João tem e-mail da empresa na base (com.email@revalle.com.br): num e-mail da empresa diferente, isso bloquearia.
const JOAO = { cpf: '52871936455', birthDate: '20/11/1985' };
const ANA = { cpf: '74612058380', birthDate: '15/01/1978' };
const CPFS = [MARIA.cpf, JOAO.cpf, ANA.cpf];

const INVOICE_MESSAGE_START = 'Nota fiscal só pode ser enviada para e-mails da empresa (@revalle.com.br';
const invoiceMessageFor = (email) => `Troque o e-mail de ${email}.`;

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

let userCookie;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);
const teamOf = (envelopeId) => db(`select "teamId" from "Envelope" where id = '${envelopeId}'`);
const linkCount = (email) => db(`select count(*) from "RevalleEmailLink" where email = '${email}'`);
const gateRow = (recipientId) =>
  db(
    `select "identityStatus" || '|' || coalesce(cpf, '-') || '|' || "failedAttempts" || '|' || ("lockedAt" is not null) from "RevalleRecipientGate" where "recipientId" = ${recipientId}`,
  );

const gate = async (procedure, input) => {
  const res = await trpc(`revalle.gate.${procedure}`, input);

  return { ...res, state: res.body?.result?.data?.json };
};
const acceptTerm = (token) => gate('acceptTerm', { token, termVersion: '1' });
const verify = (token, person) => gate('verifyIdentity', { token, cpf: person.cpf, birthDate: person.birthDate });
const confirm = (token) => gate('confirmIdentity', { token, isMe: true });

const cleanupLinks = () => {
  db(`delete from "RevalleEmailLink" where cpf in (${CPFS.map((cpf) => `'${cpf}'`).join(',')})`);
  db(`delete from "RevalleEmailLink" where email like 'ext-%-${RUN}@%'`);
};

// Documento comum enviado pela API v2 a um destinatário; devolve o destinatário com o token.
const sentTo = async (email) => {
  const created = await createEnvelope({ recipients: [{ email }] });

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);

  assert.equal(status(created.id), 'PENDING');

  return { ...recipient, envelopeId: created.id };
};

const sessionTest = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie) {
      t.skip('credenciais de sessão não informadas (REVSIGN_USER_*, REVSIGN_ADMIN_*)');

      return;
    }

    await fn(t);
  });

before(async () => {
  cleanupLinks();

  if (!user.email || !user.password || !admin.email || !admin.password) {
    return;
  }

  userCookie = await signIn(user.email, user.password);
  await ensureInvoiceAccounts(await signIn(admin.email, admin.password));
});

beforeEach(() => {
  db('delete from "RateLimit"');
});

after(() => {
  cleanupLinks();
});

test('documento comum para um gmail: criado e enviado pela API v2', async () => {
  const email = gmail('api');
  const recipient = await sentTo(email);

  assert.equal(recipient.email, email);
  assert.ok(recipient.token);
});

sessionTest('documento comum para um gmail: destinatário trocado e enviado pela tela (tRPC)', async () => {
  const draft = await createEnvelope({ recipients: [{ email: company('tela') }] });

  assert.equal(draft.status, 200, draft.text);

  const email = gmail('tela');
  const headers = { 'x-team-id': teamOf(draft.id) };
  // O mesmo destinatário (mesmo id, o campo de assinatura fica), com o e-mail trocado pelo de fora, como o editor grava.
  const recipientId = Number(db(`select id from "Recipient" where "envelopeId" = '${draft.id}'`));
  const set = await trpcAs(
    userCookie,
    'mutation',
    'envelope.recipient.set',
    {
      envelopeId: draft.id,
      envelopeType: 'DOCUMENT',
      recipients: [{ id: recipientId, email, name: 'Pessoa de Fora', role: 'SIGNER' }],
    },
    headers,
  );

  assert.equal(set.ok, true, set.text);
  assert.equal(db(`select email from "Recipient" where id = ${recipientId}`), email);

  const sent = await trpcAs(userCookie, 'mutation', 'envelope.distribute', { envelopeId: draft.id }, headers);

  assert.equal(sent.ok, true, sent.text);
  assert.equal(status(draft.id), 'PENDING');
});

sessionTest(
  'nota fiscal com um gmail: recusada no envio pela API v2 e pela tela, com a mensagem; fica rascunho',
  async () => {
    const email = gmail('nf');
    const created = await createEnvelope({
      recipients: [{ email: company('nf-ok') }, { email }],
      pdf: danfePdfFile(`ext-nf-${RUN}`),
      title: `[TESTE NF] e-mail externo ${RUN}`,
    });

    assert.equal(created.status, 200, created.text);
    assert.equal((await chooseInvoice({ cookie: userCookie, envelopeId: created.id })).status, 200);
    assert.equal(
      db(`select "isInvoice" from "RevalleInvoiceClassification" where "envelopeId" = '${created.id}'`),
      'YES',
    );

    const viaApi = await api('POST', '/envelope/distribute', { envelopeId: created.id });

    assert.equal(viaApi.status, 400, viaApi.text);
    assert.ok(viaApi.text.includes(INVOICE_MESSAGE_START), viaApi.text);
    assert.ok(viaApi.text.includes(invoiceMessageFor(email)), viaApi.text);

    const viaScreen = await trpcAs(
      userCookie,
      'mutation',
      'envelope.distribute',
      { envelopeId: created.id },
      { 'x-team-id': teamOf(created.id) },
    );

    assert.equal(viaScreen.status, 400, viaScreen.text);
    assert.ok(viaScreen.text.includes('INVOICE_EXTERNAL_RECIPIENT'), viaScreen.text);
    assert.ok(viaScreen.text.includes(invoiceMessageFor(email)), viaScreen.text);
    assert.equal(status(created.id), 'DRAFT');

    // Trocado o e-mail de fora por um da empresa, a mesma NF sai.
    db(
      `update "Recipient" set email = '${company('nf-troca')}' where "envelopeId" = '${created.id}' and email = '${email}'`,
    );

    const fixed = await api('POST', '/envelope/distribute', { envelopeId: created.id });

    assert.equal(fixed.status, 200, fixed.text);
    assert.equal(status(created.id), 'PENDING');

    // Nota fiscal enviada: um destinatário novo de fora é recusado com a mesma mensagem.
    const outsider = gmail('nf-depois');
    const added = await api('POST', '/envelope/recipient/create-many', {
      envelopeId: created.id,
      data: [{ email: outsider, name: 'Fora', role: 'SIGNER' }],
    });

    assert.equal(added.status, 400, added.text);
    assert.ok(added.text.includes(invoiceMessageFor(outsider)), added.text);
    assert.equal(db(`select count(*) from "Recipient" where email = '${outsider}'`), '0');
  },
);

sessionTest('marcar como nota fiscal um documento enviado a um gmail é recusado, com a mensagem', async () => {
  const email = gmail('marcar');
  const recipient = await sentTo(email);
  const res = await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', {
    envelopeId: recipient.envelopeId,
  });

  assert.equal(res.status, 400, res.text);
  assert.ok(res.text.includes('INVOICE_EXTERNAL_RECIPIENT'), res.text);
  assert.ok(res.text.includes(invoiceMessageFor(email)), res.text);
  assert.notEqual(
    db(
      `select coalesce((select "isInvoice"::text from "RevalleInvoiceClassification" where "envelopeId" = '${recipient.envelopeId}'), '-')`,
    ),
    'YES',
  );

  // Contraste: o mesmo documento para um e-mail da empresa é marcado.
  const ok = await sentTo(company('marcar'));
  const marked = await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: ok.envelopeId });

  assert.equal(marked.status, 200, marked.text);
});

test('portão do e-mail de fora: CPF sempre (mesmo com vínculo salvo), erro conta tentativa, CPF da base passa sem criar vínculo', async () => {
  const email = gmail('portao');
  // Um vínculo salvo para este e-mail (de antes, ou criado por engano) não dispensa a tela.
  db(`insert into "RevalleEmailLink" (id, email, cpf) values ('ext-link-${RUN}', '${email}', '${ANA.cpf}')`);
  // O CPF do João já está ligado a um e-mail da empresa (e a base tem outro e-mail para ele): para o e-mail de fora,
  // nada disso bloqueia.
  db(`insert into "RevalleEmailLink" (id, email, cpf) values ('ext-joao-${RUN}', '${company('joao')}', '${JOAO.cpf}')`);

  const r = await sentTo(email);
  const accepted = await acceptTerm(r.token);

  assert.equal(accepted.state?.status, 'IDENTITY_REQUIRED', accepted.text);
  assert.equal(accepted.state?.attemptsLeft, 5);

  const wrong = await verify(r.token, { cpf: JOAO.cpf, birthDate: '01/01/1980' });

  assert.equal(wrong.state?.status, 'IDENTITY_REQUIRED', wrong.text);
  assert.equal(wrong.state?.attemptsLeft, 4);

  const verified = await verify(r.token, JOAO);

  assert.equal(verified.state?.status, 'IDENTITY_CONFIRM', verified.text);
  assert.equal(verified.state?.preview?.primeiroNome, 'João');

  const confirmed = await confirm(r.token);

  assert.equal(confirmed.state?.status, 'PASSED', confirmed.text);
  assert.equal(gateRow(r.id), `CONFIRMED|${JOAO.cpf}|1|false`);
  // Nenhum vínculo novo: o do e-mail continua o que foi posto, e o do João continua com o e-mail da empresa.
  assert.equal(db(`select cpf from "RevalleEmailLink" where email = '${email}'`), ANA.cpf);
  assert.equal(db(`select email from "RevalleEmailLink" where cpf = '${JOAO.cpf}'`), company('joao'));
  assert.equal(
    db(
      `select count(*) from "DocumentAuditLog" where "envelopeId" = '${r.envelopeId}' and type in ('REVALLE_IDENTITY_LINKED', 'REVALLE_GATE_LOCKED')`,
    ),
    '0',
  );

  // O próximo documento para o mesmo e-mail pede CPF de novo.
  const next = await sentTo(email);

  assert.equal((await acceptTerm(next.token)).state?.status, 'IDENTITY_REQUIRED');
});

test('portão do e-mail de fora: CPF fora da base e 5 erros bloqueiam, como no e-mail da empresa', async () => {
  const r = await sentTo(gmail('bloqueio'));

  await acceptTerm(r.token);

  let last;

  for (let i = 0; i < 5; i += 1) {
    last = await verify(r.token, { cpf: '12345678909', birthDate: '01/01/1990' });
  }

  assert.equal(last.state?.status, 'LOCKED', last.text);
  assert.equal(gateRow(r.id).split('|')[3], 'true');
});

test('e-mail da empresa não muda: vínculo criado na primeira confirmação e o segundo documento não pede CPF', async () => {
  const email = company('vinculo');
  const first = await sentTo(email);

  assert.equal((await acceptTerm(first.token)).state?.status, 'IDENTITY_REQUIRED');
  assert.equal((await verify(first.token, MARIA)).state?.status, 'IDENTITY_CONFIRM');
  assert.equal((await confirm(first.token)).state?.status, 'PASSED');
  assert.equal(db(`select cpf from "RevalleEmailLink" where email = '${email}'`), MARIA.cpf);

  const second = await sentTo(email);

  assert.equal((await acceptTerm(second.token)).state?.status, 'PASSED');
  assert.equal(gateRow(second.id).split('|')[0], 'LINKED');

  // E o conflito continua valendo no e-mail da empresa: o CPF da Maria já é deste e-mail.
  const other = await sentTo(company('vinculo-outro'));

  await acceptTerm(other.token);
  assert.equal((await verify(other.token, MARIA)).state?.status, 'LOCKED');
});

test('assinatura completa por um gmail com o código do Mailpit: COMPLETED, prova com "e-mail externo", sem vínculo', async () => {
  const email = gmail('assina');
  const r = await sentTo(email);

  await acceptTerm(r.token);
  assert.equal((await verify(r.token, MARIA)).state?.status, 'IDENTITY_CONFIRM');
  assert.equal((await confirm(r.token)).state?.status, 'PASSED');

  await fetchIdempotent(`${BASE_URL}/sign/${r.token}`, {}, (res) => res.text());

  const envelope = (await api('GET', `/envelope/${r.envelopeId}`)).body;
  const field = envelope.fields.find((f) => f.recipientId === r.id && f.type === 'SIGNATURE');
  const signed = await trpc('envelope.field.sign', {
    token: r.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Pessoa de Fora' },
  });

  assert.equal(signed.status, 200, signed.text);

  const documentId = Number.parseInt(envelope.secondaryId.split('_')[1], 10);
  const done = await completeWithCode({ token: r.token, documentId, email });

  assert.ok(done.ok, done.text);

  const deadline = performance.now() + 120_000;

  while (status(r.envelopeId) !== 'COMPLETED' && performance.now() < deadline) {
    await sleep(1000);
  }

  assert.equal(status(r.envelopeId), 'COMPLETED');
  assert.equal(linkCount(email), '0');

  const factors = JSON.parse(db(`select factors from "RevalleSignatureProof" where "recipientId" = ${r.id}`));

  assert.deepEqual(
    factors.map((item) => item.factor),
    ['EMAIL_LINK', 'EMAIL_CODE', 'EMPLOYEE_CONFIRMATION', 'EXTERNAL_EMAIL'],
  );
  assert.equal(db(`select "identityVerified" from "RevalleSignatureProof" where "recipientId" = ${r.id}`), 't');
});

test('cadastro com gmail continua recusado (SIGNUP_DISABLED)', async () => {
  const email = gmail('cadastro');
  const res = await postSignup({
    name: 'Pessoa de Fora',
    email,
    password: 'Senha-de-teste-123!',
    revalleCpf: MARIA.cpf,
    revalleBirthDate: MARIA.birthDate,
  });

  assert.equal(res.status, 400, res.text);
  assert.equal(res.body?.code, 'SIGNUP_DISABLED', res.text);
  assert.equal(db(`select count(*) from "User" where email = '${email}'`), '0');
});
