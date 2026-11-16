// Conta obrigatória para quem assina pelo e-mail da empresa (decisão de 16/11/2026). Ver revalle/docs/verificacao.md,
// "E-mail da empresa: assinar com a conta".
//
// - Sem sessão, o link leva a Criar conta (e-mail travado) ou a Entrar (a conta existe), com a volta para o documento.
// - Toda ação pelo link (portão, campo, código, conclusão, recusa, PDF pendente) sem sessão: REVALLE_ACCOUNT_REQUIRED
//   (401); com a sessão de outra conta: REVALLE_ACCOUNT_MISMATCH (403); com a conta certa, assina do começo ao fim.
// - E-mail de fora da empresa, VIEWER e CC: sem conta, como antes. Termo do Patrimônio para e-mail da empresa: conta.
//
// Este teste NÃO usa `account-autologin.mjs` (ele testa justamente o pedido sem sessão).
// Requer REVSIGN_API_TOKEN; o teste do Patrimônio só roda com a stack de compose.test.yml (integração ligada).
// Pessoas fictícias de revalle/colaboradores/dev-seed.sql.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

import { ensureTestAccount, sessionFor } from './account-helpers.mjs';
import {
  BASE_URL,
  completeWithSentCode,
  createConfirmedAccount,
  createEnvelope,
  db,
  distribute,
  fetchIdempotent,
  requestEmailCode,
  SIGNUP_COLABORADOR,
  textPdfBuffer,
  trpc,
} from './helpers.mjs';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const company = (tag) => `acc-${tag}-${RUN}@revalle.com.br`;
const gmail = (tag) => `acc-${tag}-${RUN}@gmail.com`;

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const JOAO = { cpf: '52871936455', birthDate: '20/11/1985' };

const REQUIRED = 'REVALLE_ACCOUNT_REQUIRED';
const MISMATCH = 'REVALLE_ACCOUNT_MISMATCH';

const PATRIMONIO_API = `${BASE_URL}/api/revalle/patrimonio/v1`;
const PATRIMONIO_KEY = 'test-only-patrimonio-api-key-not-a-secret';

const cookieHeaders = (cookie) => (cookie ? { Cookie: cookie } : {});

// tRPC GET (query), como a página faz.
const trpcQuery = (procedure, input, headers = {}) =>
  fetchIdempotent(`${BASE_URL}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`, {
    headers: { Origin: new URL(BASE_URL).origin, ...headers },
  });

const gateState = (res) => res.body?.result?.data?.json;

// Dados do loader da página (React Router, `<rota>.data`), sem o HTML: só o que o servidor decidiu.
const routeData = async (pathname, search = '') =>
  fetchIdempotent(`${BASE_URL}${pathname}.data${search}`, {}, (res) => res.text());

const openLink = (token, cookie, sub = '') =>
  fetch(`${BASE_URL}/sign/${token}${sub}`, { redirect: 'manual', headers: cookieHeaders(cookie) });

// Documento comum enviado pela API v2; devolve o destinatário (com token), o documentId, o campo e o item.
const sendTo = async (recipients, { title } = {}) => {
  const created = await createEnvelope({ recipients, title });

  assert.equal(created.status, 200, created.text);

  const sent = await distribute(created.id);
  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const itemId = created.envelope.envelopeItems[0].id;
  const withFields = sent.map((recipient) => ({
    ...recipient,
    documentId,
    itemId,
    envelopeId: created.id,
    field: created.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE'),
  }));

  return withFields;
};

const signerTo = async (email, options) => (await sendTo([{ email }], options))[0];

// Toda ação pelo link, com a sessão dada (ou nenhuma). Devolve [nome, resposta].
const everyAction = async (s, cookie) => {
  const h = cookieHeaders(cookie);
  const { token } = s;

  return [
    ['portão: aceitar termo', await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' }, h)],
    ['portão: CPF', await trpc('revalle.gate.verifyIdentity', { token, ...MARIA }, h)],
    ['portão: sou eu', await trpc('revalle.gate.confirmIdentity', { token, isMe: true }, h)],
    ['código por e-mail', await trpc('document.accessAuth.request2FAEmail', { token }, h)],
    [
      'assinar campo (v2)',
      await trpc(
        'envelope.field.sign',
        { token, fieldId: s.field.id, fieldValue: { type: 'SIGNATURE', value: 'Teste' } },
        h,
      ),
    ],
    ['assinar campo (v1)', await trpc('field.signFieldWithToken', { token, fieldId: s.field.id, value: 'Teste' }, h)],
    ['desfazer campo', await trpc('field.removeSignedFieldWithToken', { token, fieldId: s.field.id }, h)],
    [
      'concluir',
      await trpc(
        'recipient.completeDocumentWithToken',
        {
          token,
          documentId: s.documentId,
          accessAuthOptions: { type: 'TWO_FACTOR_AUTH', method: 'email', token: '000000' },
        },
        h,
      ),
    ],
    [
      'recusar',
      await trpc('recipient.rejectDocumentWithToken', { token, documentId: s.documentId, reason: 'teste' }, h),
    ],
    [
      'arquivos por token',
      await trpcQuery(
        'envelope.item.getManyByToken',
        { envelopeId: s.envelopeId, access: { type: 'recipient', token } },
        h,
      ),
    ],
    ['anexos por token', await trpcQuery('envelope.attachment.find', { envelopeId: s.envelopeId, token }, h)],
  ];
};

const assertRefused = (results, code, status) => {
  for (const [name, res] of results) {
    assert.equal(res.status, status, `${name}: esperava ${status} ${code}, veio ${res.status} ${res.text}`);
    assert.ok(res.text.includes(code), `${name}: esperava o código ${code}: ${res.text}`);
  }
};

const assertUntouched = (s) => {
  assert.equal(db(`select "signingStatus" from "Recipient" where id = ${s.id}`), 'NOT_SIGNED');
  assert.equal(
    db(`select count(*) from "RevalleRecipientGate" where "recipientId" = ${s.id} and "termAcceptedAt" is not null`),
    '0',
    'o termo não pode ter sido aceito sem a conta',
  );
  assert.equal(db(`select count(*) from "Field" where id = ${s.field.id} and inserted`), '0');
};

const pdfDownload = (s, cookie) =>
  fetch(`${BASE_URL}/api/files/token/${s.token}/envelopeItem/${s.itemId}/download/original`, {
    headers: cookieHeaders(cookie),
  });

beforeEach(() => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf in ('${MARIA.cpf}', '${JOAO.cpf}')`);
});

after(() => {
  db(`delete from "RevalleEmailLink" where email like 'acc-%-${RUN}@%'`);
});

test('sem conta e sem sessão: o link leva a Criar conta com o e-mail travado e a volta para o documento', async () => {
  const email = company('novo');
  const s = await signerTo(email);
  const res = await openLink(s.token);

  assert.equal(res.status, 302, await res.text());

  const location = new URL(res.headers.get('location'), BASE_URL);

  assert.equal(location.pathname, '/signup');
  assert.equal(location.searchParams.get('email'), email);
  assert.equal(location.searchParams.get('returnTo'), `/sign/${s.token}`);

  // A página de cadastro vem com o e-mail do link, travado.
  const signup = await (await fetch(location)).text();

  assert.ok(signup.includes(email), 'o e-mail do link vem preenchido');
  assert.match(signup, /readonly/i, 'o e-mail do link vem travado');

  // Nos dados da página (só o loader), o e-mail travado vem do servidor.
  assert.ok((await routeData('/signup', location.search)).includes(email));

  // Outro e-mail, ou a volta para fora da página de assinatura: nada travado (o e-mail nem volta nos dados).
  for (const [other, returnTo] of [
    [company('outro'), `/sign/${s.token}`],
    [email, 'https://evil.example/sign/x'],
    [email, `//evil.example/sign/${s.token}`],
    [email, `/sign/${s.token}/../../settings`],
  ]) {
    const data = await routeData('/signup', `?${new URLSearchParams({ email: other, returnTo })}`);

    assert.ok(!data.includes(other), `não trava com ${other} e ${returnTo}`);
  }

  // Nada do documento foi aberto.
  assert.equal(
    db(
      `select count(*) from "DocumentAuditLog" where "envelopeId" = '${s.envelopeId}' and type in ('DOCUMENT_OPENED','DOCUMENT_VIEWED')`,
    ),
    '0',
  );
});

test('com conta e sem sessão: o link leva a Entrar com o e-mail e a volta para o documento', async () => {
  const email = ensureTestAccount(company('existe'));
  const s = await signerTo(email);
  const res = await openLink(s.token);

  assert.equal(res.status, 302, await res.text());

  const location = new URL(res.headers.get('location'), BASE_URL);

  assert.equal(location.pathname, '/signin');
  assert.equal(location.searchParams.get('email'), email);
  assert.equal(location.searchParams.get('returnTo'), `/sign/${s.token}`);

  // Já logado na conta certa, Entrar devolve ao documento; a volta para fora do app é ignorada.
  const cookie = await sessionFor(email);
  const back = await fetch(`${BASE_URL}/signin?returnTo=${encodeURIComponent(`/sign/${s.token}`)}`, {
    redirect: 'manual',
    headers: { Cookie: cookie },
  });

  assert.equal(back.status, 302);
  assert.equal(new URL(back.headers.get('location'), BASE_URL).pathname, `/sign/${s.token}`);

  const evil = await fetch(`${BASE_URL}/signin?returnTo=${encodeURIComponent('https://evil.example/sign/x')}`, {
    redirect: 'manual',
    headers: { Cookie: cookie },
  });

  assert.equal(evil.status, 302);
  assert.equal(new URL(evil.headers.get('location'), BASE_URL).origin, new URL(BASE_URL).origin);
});

test('sem sessão, toda ação pelo link é recusada com REVALLE_ACCOUNT_REQUIRED (401), e o PDF pendente também', async () => {
  const s = await signerTo(company('semsessao'));

  assertRefused(await everyAction(s), REQUIRED, 401);
  assertUntouched(s);
  assert.equal((await pdfDownload(s)).status, 403);
});

test('com a sessão de outra conta: REVALLE_ACCOUNT_MISMATCH (403) e a página de troca de conta', async () => {
  const title = `[TESTE] titulo-conta-${RUN}`;
  const recipientEmail = company('dono');
  const s = await signerTo(recipientEmail, { title });
  const other = await sessionFor(company('intruso'));

  assertRefused(await everyAction(s, other), MISMATCH, 403);
  assertUntouched(s);
  assert.equal((await pdfDownload(s, other)).status, 403);

  const res = await openLink(s.token, other);
  const html = await res.text();

  assert.equal(res.status, 200, html);
  assert.ok(html.includes(recipientEmail), 'a página diz para qual e-mail é o documento');
  assert.ok(!html.includes(title), 'nada do documento na página de troca de conta');
  assert.ok(html.includes(`returnTo=%2Fsign%2F${s.token}`), 'o botão leva a entrar com a volta para o documento');
});

test('com a conta certa (cadastro com CPF e confirmação): termo, sem CPF, assinatura e código, do começo ao fim', async () => {
  const password = `Senha-${RUN}-Teste!`;
  const account = await createConfirmedAccount({ email: company('certa'), name: 'Teste Cadastro', password });
  const s = await signerTo(account.email);
  const h = { Cookie: account.cookie };

  // A página abre (sem redirecionar) e mostra o portão.
  const page = await openLink(s.token, account.cookie);

  assert.equal(page.status, 200);
  assert.match(await page.text(), /Antes de assinar/);

  // Cadastro já fez o vínculo e-mail ↔ CPF: depois do termo, o portão passa sem a tela de CPF.
  const accepted = await trpc('revalle.gate.acceptTerm', { token: s.token, termVersion: '1' }, h);

  assert.equal(gateState(accepted)?.status, 'PASSED', accepted.text);
  assert.equal(db(`select cpf from "RevalleEmailLink" where email = '${account.email}'`), SIGNUP_COLABORADOR.cpf);

  const signed = await trpc(
    'envelope.field.sign',
    { token: s.token, fieldId: s.field.id, fieldValue: { type: 'SIGNATURE', value: 'Teste' } },
    h,
  );

  assert.equal(signed.status, 200, signed.text);
  assert.equal((await pdfDownload(s, account.cookie)).status, 200);

  // O código por e-mail continua: pedido e conclusão com a sessão.
  const { requested, code } = await requestEmailCode({ token: s.token, email: account.email, headers: h });

  assert.equal(requested.status, 200, requested.text);

  const done = await completeWithSentCode({ token: s.token, documentId: s.documentId, code, headers: h });

  assert.equal(done.status, 200, done.text);
  assert.equal(db(`select "signingStatus" from "Recipient" where id = ${s.id}`), 'SIGNED');

  // Depois de assinar, o link continua abrindo como antes (decisão: documento concluído não pede login).
  const completed = await openLink(s.token, undefined, '/complete');

  assert.equal(completed.status, 200);
});

test('e-mail de fora da empresa assina sem conta, como antes (CPF e data em todo documento)', async () => {
  const s = await signerTo(gmail('externo'));
  const page = await openLink(s.token);

  assert.equal(page.status, 200, 'sem redirecionar para Entrar/Criar conta');

  const accepted = await trpc('revalle.gate.acceptTerm', { token: s.token, termVersion: '1' });

  assert.equal(gateState(accepted)?.status, 'IDENTITY_REQUIRED', accepted.text);

  const verified = await trpc('revalle.gate.verifyIdentity', { token: s.token, ...MARIA });

  assert.equal(gateState(verified)?.status, 'IDENTITY_CONFIRM', verified.text);
  assert.equal(gateState(await trpc('revalle.gate.confirmIdentity', { token: s.token, isMe: true }))?.status, 'PASSED');

  const signed = await trpc('envelope.field.sign', {
    token: s.token,
    fieldId: s.field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Teste' },
  });

  assert.equal(signed.status, 200, signed.text);

  const { requested, code } = await requestEmailCode({ token: s.token, email: s.email });

  assert.equal(requested.status, 200, requested.text);
  assert.equal((await completeWithSentCode({ token: s.token, documentId: s.documentId, code })).status, 200);
});

test('VIEWER e CC do e-mail da empresa não precisam de login', async () => {
  const recipients = await sendTo([
    { email: gmail('assina') },
    { email: company('leitor'), role: 'VIEWER', fields: [] },
    { email: company('copia'), role: 'CC', fields: [] },
  ]);
  const viewer = recipients.find((r) => r.role === 'VIEWER');
  const cc = recipients.find((r) => r.role === 'CC');

  const viewerPage = await openLink(viewer.token);

  assert.equal(viewerPage.status, 200, 'o leitor abre o link sem login');

  // O leitor pede o código para "marcar como visto" sem conta.
  assert.equal((await trpc('document.accessAuth.request2FAEmail', { token: viewer.token })).status, 200);

  const ccPage = await openLink(cc.token);
  const ccLocation = ccPage.headers.get('location') ?? '';

  assert.ok(!/\/sign(in|up)\b/.test(ccLocation), `a cópia não vai para Entrar/Criar conta (${ccLocation})`);
});

test('a volta para o documento só aceita /sign/<token>: a página de confirmação ignora outro endereço', async () => {
  const query = (returnTo) => `?${new URLSearchParams({ returnTo })}`;

  // A volta válida vai nos dados da página (para o aviso e para guardar no navegador); qualquer outra, não.
  assert.ok((await routeData('/unverified-account', query('/sign/abc_DEF-1'))).includes('/sign/abc_DEF-1'));

  for (const returnTo of [
    'https://evil.example/sign/abc',
    '//evil.example/sign/abc',
    '/sign/abc/../../evil-path',
    '/evil-path',
  ]) {
    const data = await routeData('/unverified-account', query(returnTo));

    assert.ok(!data.includes('evil'), `${returnTo} não pode voltar nos dados: ${data}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Termo do Patrimônio enviado a um e-mail da empresa: a conta também é exigida (além do CPF do termo).
// ---------------------------------------------------------------------------------------------------------------
const TERMO_PDF = textPdfBuffer([
  'TERMO DE RESPONSABILIDADE DE EQUIPAMENTO',
  'Equipamento: Notebook de teste, patrimonio 000123',
  'Assinatura do colaborador: {{ Assinatura }}',
]);

const createTermo = async (signerEmail, tag) => {
  const form = new FormData();
  const fields = {
    externalId: `PAT-ACC-${tag}-${RUN}`,
    kind: 'ENTREGA',
    title: `[TESTE] Termo conta ${RUN}`,
    signerName: 'João Exemplo Pereira',
    signerEmail,
    signerCpf: JOAO.cpf,
  };

  for (const [name, value] of Object.entries(fields)) {
    form.append(name, value);
  }

  form.append('file', new File([TERMO_PDF], 'termo.pdf', { type: 'application/pdf' }));

  const res = await fetch(`${PATRIMONIO_API}/termos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PATRIMONIO_KEY}` },
    body: form,
  });
  const text = await res.text();

  return { status: res.status, text, body: text ? JSON.parse(text) : undefined };
};

const termoSigner = (termoId) => {
  const [id, token, email] = db(
    `select id || '|' || token || '|' || email from "Recipient" where "envelopeId" = '${termoId}'`,
  ).split('|');
  const secondaryId = db(`select "secondaryId" from "Envelope" where id = '${termoId}'`);
  const fieldId = Number(db(`select id from "Field" where "envelopeId" = '${termoId}' and type = 'SIGNATURE' limit 1`));

  return { id: Number(id), token, email, documentId: Number.parseInt(secondaryId.split('_')[1], 10), fieldId };
};

test('termo do Patrimônio para e-mail da empresa exige a conta; para e-mail pessoal, não', async (t) => {
  const email = company('patrimonio');
  const created = await createTermo(email, 'empresa');

  if (created.status === 404) {
    t.skip('integração do Patrimônio desligada (suba a stack com compose.test.yml)');

    return;
  }

  assert.equal(created.status, 201, created.text);

  const s = termoSigner(created.body.termoId);

  // Sem sessão: Criar conta (a conta ainda não existe) e o portão recusado.
  const res = await openLink(s.token);

  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get('location'), BASE_URL).pathname, '/signup');

  const refused = await trpc('revalle.gate.acceptTerm', { token: s.token, termVersion: '1' });

  assert.equal(refused.status, 401, refused.text);
  assert.ok(refused.text.includes(REQUIRED));

  // Com a conta: termo, CPF do termo (sempre, mesmo com a conta), assinatura e código.
  const h = { Cookie: await sessionFor(email) };
  const accepted = await trpc('revalle.gate.acceptTerm', { token: s.token, termVersion: '1' }, h);

  assert.equal(gateState(accepted)?.status, 'IDENTITY_REQUIRED', accepted.text);

  const verified = await trpc('revalle.gate.verifyIdentity', { token: s.token, ...JOAO }, h);

  assert.equal(gateState(verified)?.status, 'IDENTITY_CONFIRM', verified.text);
  assert.equal(
    gateState(await trpc('revalle.gate.confirmIdentity', { token: s.token, isMe: true }, h))?.status,
    'PASSED',
  );

  const signed = await trpc(
    'envelope.field.sign',
    { token: s.token, fieldId: s.fieldId, fieldValue: { type: 'SIGNATURE', value: 'Teste' } },
    h,
  );

  assert.equal(signed.status, 200, signed.text);

  const { requested, code } = await requestEmailCode({ token: s.token, email, headers: h });

  assert.equal(requested.status, 200, requested.text);
  assert.equal(
    (await completeWithSentCode({ token: s.token, documentId: s.documentId, code, headers: h })).status,
    200,
  );

  // Termo para e-mail pessoal: o portão anda sem sessão, como antes.
  const personal = await createTermo(gmail('patrimonio'), 'pessoal');

  assert.equal(personal.status, 201, personal.text);

  const p = termoSigner(personal.body.termoId);

  assert.equal((await openLink(p.token)).status, 200);
  assert.equal(
    gateState(await trpc('revalle.gate.acceptTerm', { token: p.token, termVersion: '1' }))?.status,
    'IDENTITY_REQUIRED',
  );
});
