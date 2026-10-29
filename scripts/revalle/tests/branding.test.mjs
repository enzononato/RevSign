// Marca RevSign (Task 3, Fase 2): nenhum "Documenso" visível nas telas, no manifest, nos e-mails de um fluxo real
// (cadastro, convite para assinar, código, documento concluído) nem no certificado/log do PDF selado.
// Fica de fora só o link "Código-fonte (AGPL-3.0)" (regra 8). Classes CSS (`documenso-branded`, `text-documenso-700`)
// são identificadores de código, não texto: por isso a busca no HTML é por "Documenso" com D maiúsculo e por
// links/handles do Documenso (documenso.com, @documenso).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
  api,
  BASE_URL,
  completeWithCode,
  createEnvelope,
  db,
  distribute,
  downloadItem,
  fetchIdempotent,
  poppler,
  signIn,
  trpc,
} from './helpers.mjs';

const MAILPIT = 'http://localhost:8025/api/v1';
const FERNANDO = { cpf: '93457210888', birthDate: '31/12/1999' };
const PASSWORD = 'Senha-Forte-123!';
const VISIBLE_DOCUMENSO = /Documenso|documenso\.com|@documenso(?![/\w-])/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// HTML como o usuário vê: sem o conteúdo dos <script> (dados de hidratação e catálogo) e sem o link da AGPL.
const visibleHtml = (html) =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<a\b[^>]*>\s*Código-fonte \(AGPL-3\.0\)\s*<\/a>/g, '');

const assertNoDocumenso = (label, text, pattern = VISIBLE_DOCUMENSO) => {
  const index = text.search(pattern);

  assert.equal(index, -1, `${label} ainda mostra Documenso: …${text.slice(Math.max(0, index - 80), index + 80)}…`);
};

const titleOf = (html) => html.match(/<title>([^<]*)<\/title>/)?.[1];

const getPage = async (route, headers = {}) => {
  const res = await fetchIdempotent(`${BASE_URL}${route}`, { headers }, async (r) => ({
    status: r.status,
    text: await r.text(),
  }));

  assert.equal(res.status, 200, `${route}: HTTP ${res.status}`);

  return res.text;
};

const mailpit = (route) => fetchIdempotent(`${MAILPIT}${route}`, {}, (res) => res.json());

// Todas as mensagens que casam com a busca do Mailpit, já com corpo (HTML e texto).
const mailsMatching = async (query) => {
  const list = await mailpit(`/search?query=${encodeURIComponent(query)}&limit=50`);

  return Promise.all((list.messages ?? []).map((message) => mailpit(`/message/${message.ID}`)));
};

const waitForMails = async (query, minimum) => {
  let mails = [];

  for (let i = 0; i < 40 && mails.length < minimum; i += 1) {
    mails = await mailsMatching(query);

    if (mails.length < minimum) {
      await sleep(500);
    }
  }

  return mails;
};

const assertMailBranding = (mail) => {
  const label = `e-mail "${mail.Subject}" para ${mail.To?.[0]?.Address}`;

  assert.equal(mail.From?.Name, 'RevSign', `${label}: remetente`);
  assertNoDocumenso(`${label} (assunto)`, mail.Subject);
  assertNoDocumenso(`${label} (HTML)`, mail.HTML ?? '');
  assertNoDocumenso(`${label} (texto)`, mail.Text ?? '');
};

const signup = { email: `marca-${randomUUID().slice(0, 8)}@revalle.com.br` };
const flow = {};

before(async () => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${FERNANDO.cpf}'`);

  const origin = new URL(BASE_URL).origin;
  const created = await fetch(`${BASE_URL}/api/auth/email-password/signup`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Forwarded-For': `203.0.113.${Math.floor(Math.random() * 250) + 1}`,
    },
    body: JSON.stringify({ name: 'Teste Marca', email: signup.email, password: PASSWORD }),
  });

  assert.ok(created.ok, `cadastro falhou (${created.status}): ${await created.text()}`);
  [signup.confirmation] = await waitForMails(`to:${signup.email}`, 1);

  flow.title = `[TESTE] Marca ${randomUUID().slice(0, 8)}`;
  flow.signerEmail = `marca-sign-${randomUUID().slice(0, 8)}@revalle.com.br`;

  const envelope = await createEnvelope({
    title: flow.title,
    recipients: [{ email: flow.signerEmail, name: 'Marca Um' }],
    meta: { distributionMethod: 'EMAIL' },
  });

  assert.equal(envelope.status, 200, envelope.text);

  const [recipient] = await distribute(envelope.id);
  const documentId = Number.parseInt(envelope.envelope.secondaryId.split('_')[1], 10);
  const field = envelope.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');
  const { token } = recipient;

  flow.signPageHtml = await getPage(`/sign/${token}`);

  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...FERNANDO });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });

  const signed = await trpc('envelope.field.sign', {
    token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Teste' },
  });

  assert.equal(signed.status, 200, signed.text);

  const completed = await completeWithCode({ token, documentId, email: flow.signerEmail });

  assert.equal(completed.status, 200, completed.text);

  for (let i = 0; i < 60; i += 1) {
    if ((await api('GET', `/envelope/${envelope.id}`)).body.status === 'COMPLETED') {
      break;
    }

    await sleep(3000);
  }

  // Convite, código e "documento concluído" para quem assinou.
  flow.signerMails = await waitForMails(`to:${flow.signerEmail}`, 3);

  flow.dir = mkdtempSync(path.join(tmpdir(), 'marca-'));
  flow.pdf = await downloadItem(envelope.envelope.envelopeItems[0].id, 'signed');
  writeFileSync(path.join(flow.dir, 'signed.pdf'), flow.pdf);

  flow.pdfInfo = poppler(flow.dir, 'pdfinfo /pdf/signed.pdf');

  const total = Number(flow.pdfInfo.match(/^Pages:\s+(\d+)/m)[1]);

  flow.certificateText = poppler(flow.dir, `pdftotext -f 2 -l ${total} -layout /pdf/signed.pdf -`);
  flow.signatureInfo = poppler(flow.dir, 'pdfsig /pdf/signed.pdf || true');
});

after(() => {
  db(`delete from "RevalleEmailLink" where cpf = '${FERNANDO.cpf}'`);
});

test('páginas públicas: nenhum Documenso visível e título "<Página> · RevSign"', async () => {
  for (const route of ['/signin', '/signup', '/verificar', '/privacidade', '/articles/signature-disclosure']) {
    const html = await getPage(route);

    assertNoDocumenso(route, visibleHtml(html));
    assert.match(titleOf(html) ?? '', /^\S.* · RevSign$/, `${route}: título "${titleOf(html)}"`);
  }
});

test('página de assinatura: nenhum Documenso visível e título "· RevSign"', () => {
  assertNoDocumenso('/sign/<token>', visibleHtml(flow.signPageHtml));
  assert.match(titleOf(flow.signPageHtml) ?? '', /^\S.* · RevSign$/, `título "${titleOf(flow.signPageHtml)}"`);
});

test('site.webmanifest: nome RevSign e cor da marca', async () => {
  const manifest = JSON.parse(await getPage('/site.webmanifest'));

  assertNoDocumenso('site.webmanifest', JSON.stringify(manifest), /documenso/i);
  assert.equal(manifest.name, 'RevSign');
  assert.equal(manifest.short_name, 'RevSign');
  assert.equal(manifest.theme_color.toUpperCase(), '#1F4E79');
});

test('e-mail de confirmação do cadastro: remetente RevSign e nenhum Documenso', () => {
  assert.ok(signup.confirmation, 'e-mail de confirmação não chegou ao Mailpit');
  assertMailBranding(signup.confirmation);
});

test('e-mails do fluxo de assinatura (convite, código, concluído): remetente RevSign e nenhum Documenso', async () => {
  const ownerMails = (await mailsMatching(`"${flow.title}"`)).filter(
    (mail) => !mail.To.some((to) => to.Address === flow.signerEmail),
  );
  const mails = [...flow.signerMails, ...ownerMails];

  assert.ok(
    flow.signerMails.length >= 3,
    `esperava ao menos 3 e-mails para quem assina, veio ${flow.signerMails.length}`,
  );

  for (const mail of mails) {
    assertMailBranding(mail);
  }
});

test('certificado e log do PDF selado: nenhum Documenso no texto, nos metadados nem no motivo da assinatura', () => {
  assertNoDocumenso('certificado/log (pdftotext)', flow.certificateText, /documenso/i);
  assertNoDocumenso('metadados (pdfinfo)', flow.pdfInfo, /documenso/i);
  assertNoDocumenso('assinatura (pdfsig)', flow.signatureInfo, /documenso/i);

  // O pdfsig não mostra o motivo (/Reason); o dicionário da assinatura fica sem compressão no arquivo.
  const raw = flow.pdf.toString('latin1');
  const reason = raw.match(/\/Reason \(([^)]*)\)/)?.[1];

  assert.ok(reason, 'assinatura sem /Reason');
  assert.match(reason, /RevSign/);
  const pdfLabels = [...raw.matchAll(/\/(Reason|Producer|Creator) \([^)]*\)/g)].map(([entry]) => entry).join(' ');

  assertNoDocumenso('/Reason, /Producer e /Creator', pdfLabels, /documenso/i);
});

test('conta nova: confirmação do e-mail, "Equipe pessoal" no menu e autenticador (2FA) como RevSign', async () => {
  const link = signup.confirmation?.HTML?.match(/\/verify-email\/[A-Za-z0-9_-]+/)?.[0];

  assert.ok(link, 'link de confirmação ausente no e-mail');
  assertNoDocumenso(link.split('/').slice(0, 2).join('/'), visibleHtml(await getPage(link)));

  // A tela confirma pelo navegador (POST da página); aqui o mesmo pedido, sem navegador.
  const verified = await fetch(`${BASE_URL}/api/auth/email-password/verify-email`, {
    method: 'POST',
    headers: { Origin: new URL(BASE_URL).origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: link.split('/').pop() }),
  });

  assert.equal(verified.status, 200, await verified.text());

  const cookie = await signIn(signup.email, PASSWORD);
  // A conta nova ganha organização e equipe pessoais com nome em pt-BR (o nome vai para o banco, sem catálogo).
  const home = await fetchIdempotent(`${BASE_URL}/`, { headers: { Cookie: cookie } }, async (r) => ({
    status: r.status,
    url: r.url,
    text: await r.text(),
  }));

  assert.equal(home.status, 200, `${home.url}: HTTP ${home.status}`);
  assert.ok(visibleHtml(home.text).includes('Equipe pessoal'), `menu sem "Equipe pessoal" em ${home.url}`);
  assert.ok(!visibleHtml(home.text).includes('Personal Team'), `menu ainda com "Personal Team" em ${home.url}`);
  assertNoDocumenso(new URL(home.url).pathname, visibleHtml(home.text));

  const res = await fetch(`${BASE_URL}/api/auth/two-factor/setup`, {
    method: 'POST',
    headers: { Origin: new URL(BASE_URL).origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(body.uri, /^otpauth:\/\/totp\/RevSign:/);
  assert.match(body.uri, /[?&]issuer=RevSign(&|$)/);
});
