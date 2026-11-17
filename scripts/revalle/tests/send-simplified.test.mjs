// Envio simplificado (pedido de 17/11/2026, docs/superpowers/specs/2026-11-17-envio-simplificado-design.md). Roda contra a
// stack local. Requer REVSIGN_API_TOKEN e REVSIGN_USER_EMAIL/REVSIGN_USER_PASSWORD (dono do token: quem envia).
//
// - Mailpit: sem assunto gravado, o convite sai com `{quem enviou} enviou "{título}" para você {assinar|aprovar|ver}`
//   (sem nome, o do time) e com Reply-To = e-mail de quem enviou (quando nem o time nem a organização definiram um).
//   Um e-mail por signatário. Assunto e e-mail para resposta gravados (API, documento antigo) continuam valendo.
// - Navegador (imagem do Playwright): o diálogo de envio não tem as abas nem os campos "E-mail para resposta",
//   "Assunto" e "Mensagem"; tem as duas opções com o texto exato. "Só gerar os links" envia sem e-mail e abre a tela dos
//   links; "Enviar por e-mail" manda um e-mail por signatário. As "Configurações do documento" (aba Notificações) não
//   têm mais os três campos.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, test } from 'node:test';

import {
  BASE_URL,
  createEnvelope,
  db,
  distribute,
  hasPlaywrightImage,
  mailById,
  mailsTo,
  PLAYWRIGHT_IMAGE,
  runBrowserScript,
  signIn,
  waitNewMail,
} from './helpers.mjs';

const USER_EMAIL = process.env.REVSIGN_USER_EMAIL;
const USER_PASSWORD = process.env.REVSIGN_USER_PASSWORD;
const SHOT_DIR = process.env.REVSIGN_SEND_SIMPLIFIED_SHOTS;
const skip = !(process.env.REVSIGN_API_TOKEN && USER_EMAIL && USER_PASSWORD) && 'sem token/usuário do teste';

const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
const unique = (label) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@gmail.com`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fx = {};

const teamOf = (envelopeId) =>
  db(`select t.url from "Team" t join "Envelope" e on e."teamId" = t.id where e.id = ${sql(envelopeId)}`);

// Quem enviou (o dono do token) e o time do envelope: o nome de quem enviou, ou o do time quando não tiver nome.
const senderLabel = (envelopeId) =>
  db(
    `select coalesce(nullif(trim(u.name), ''), t.name) from "User" u, "Team" t join "Envelope" e on e."teamId" = t.id where u.email = ${sql(USER_EMAIL)} and e.id = ${sql(envelopeId)}`,
  );

// O Reply-To esperado: o do time, senão o da organização, senão o e-mail de quem enviou.
const expectedReplyTo = (envelopeId) =>
  db(
    `select coalesce(nullif(tgs."emailReplyTo", ''), nullif(ogs."emailReplyTo", ''), ${sql(USER_EMAIL)})
       from "Envelope" e
       join "Team" t on t.id = e."teamId"
       join "TeamGlobalSettings" tgs on tgs.id = t."teamGlobalSettingsId"
       join "Organisation" o on o.id = t."organisationId"
       join "OrganisationGlobalSettings" ogs on ogs.id = o."organisationGlobalSettingsId"
      where e.id = ${sql(envelopeId)}`,
  );

const replyToOf = (mail) => (mail.ReplyTo ?? []).map((address) => address.Address.toLowerCase());

// Espera o convite (o link de assinatura) de cada e-mail e confere que, alguns segundos depois, chegou só um.
const waitOneInviteEach = async (emails) => {
  const mails = new Map();

  for (const email of emails) {
    mails.set(email, await waitNewMail(email, new Set(), { what: `convite para ${email}` }));
  }

  await sleep(5000);

  for (const email of emails) {
    assert.equal((await mailsTo(email)).length, 1, `${email} recebeu mais de um e-mail`);
  }

  return mails;
};

const statusOf = (envelopeId) => db(`select status from "Envelope" where id = ${sql(envelopeId)}`);
const distributionOf = (envelopeId) =>
  db(
    `select m."distributionMethod" from "DocumentMeta" m join "Envelope" e on e."documentMetaId" = m.id where e.id = ${sql(envelopeId)}`,
  );

before(async () => {
  if (skip) {
    return;
  }

  fx.cookie = await signIn(USER_EMAIL, USER_PASSWORD);
});

test('sem assunto gravado: assunto novo por papel, Reply-To de quem enviou, um e-mail por pessoa', {
  skip,
}, async () => {
  const title = `[TESTE] envio simplificado ${randomUUID().slice(0, 8)}`;
  const signerA = unique('simples-a');
  const signerB = unique('simples-b');
  const approver = unique('simples-aprova');
  const viewer = unique('simples-ve');

  const created = await createEnvelope({
    title,
    meta: { distributionMethod: 'EMAIL' },
    recipients: [
      { email: signerA, name: 'Ana Simples' },
      { email: signerB, name: 'Bruno Simples' },
      { email: approver, name: 'Carla Aprova', role: 'APPROVER', fields: [] },
      { email: viewer, name: 'Davi Vê', role: 'VIEWER', fields: [] },
    ],
  });

  assert.equal(created.status, 200, created.text);

  await distribute(created.id);

  const sender = senderLabel(created.id);
  const replyTo = expectedReplyTo(created.id).toLowerCase();

  assert.ok(sender, 'sem o nome de quem enviou nem do time');

  const mails = await waitOneInviteEach([signerA, signerB, approver, viewer]);

  for (const [email, verb] of [
    [signerA, 'assinar'],
    [signerB, 'assinar'],
    [approver, 'aprovar'],
    [viewer, 'ver'],
  ]) {
    const mail = mails.get(email);

    assert.equal(mail.Subject, `${sender} enviou "${title}" para você ${verb}`, `assunto para ${email}`);
    assert.deepEqual(replyToOf(mail), [replyTo], `Reply-To para ${email}`);
  }
});

test('assunto e e-mail para resposta gravados (API, documento antigo) continuam valendo', { skip }, async () => {
  const title = `[TESTE] envio com assunto ${randomUUID().slice(0, 8)}`;
  const signer = unique('simples-antigo');
  const subject = `Assunto gravado ${randomUUID().slice(0, 6)}`;

  const created = await createEnvelope({
    title,
    meta: { distributionMethod: 'EMAIL', subject, emailReplyTo: 'resposta-gravada@revalle.com.br' },
    recipients: [{ email: signer, name: 'Elisa Antiga' }],
  });

  assert.equal(created.status, 200, created.text);

  await distribute(created.id);

  const mail = (await waitOneInviteEach([signer])).get(signer);

  assert.equal(mail.Subject, subject);
  assert.deepEqual(replyToOf(mail), ['resposta-gravada@revalle.com.br']);
});

test('navegador: diálogo com as duas opções, "Só gerar os links" e "Enviar por e-mail"', async (t) => {
  if (skip) {
    t.skip(skip);

    return;
  }

  if (!hasPlaywrightImage()) {
    t.skip(`imagem ${PLAYWRIGHT_IMAGE} ausente no Docker (docker pull ${PLAYWRIGHT_IMAGE})`);

    return;
  }

  const draft = async (label, emails) => {
    const created = await createEnvelope({
      title: `[TESTE] ${label} ${randomUUID().slice(0, 8)}`,
      meta: { distributionMethod: 'EMAIL' },
      recipients: emails.map((email, index) => ({ email, name: `Pessoa ${index + 1}` })),
    });

    assert.equal(created.status, 200, created.text);

    return created.id;
  };

  const linkEmails = [unique('simples-links-a'), unique('simples-links-b')];
  const emailEmails = [unique('simples-email-a'), unique('simples-email-b')];
  const linksId = await draft('só links', linkEmails);
  const emailId = await draft('por e-mail', emailEmails);

  const browser = await runBrowserScript({
    script: 'send-simplified.browser.mjs',
    payload: { baseUrl: BASE_URL, teamUrl: teamOf(linksId), ownerCookie: fx.cookie, linksId, emailId },
    shotDir: SHOT_DIR,
    timeout: 240_000,
  });

  t.diagnostic(browser.stdout);
  assert.equal(browser.status, 0, `${browser.stdout}\n${browser.stderr}`);

  // "Só gerar os links": enviado (pendente), gravado como NONE e nenhum e-mail para ninguém.
  assert.equal(statusOf(linksId), 'PENDING');
  assert.equal(distributionOf(linksId), 'NONE');
  await sleep(8000);

  for (const email of linkEmails) {
    assert.equal((await mailsTo(email)).length, 0, `${email} recebeu e-mail no "Só gerar os links"`);
  }

  // "Enviar por e-mail": um convite por signatário, com o assunto novo.
  assert.equal(statusOf(emailId), 'PENDING');
  assert.equal(distributionOf(emailId), 'EMAIL');

  const mails = await waitOneInviteEach(emailEmails);
  const sender = senderLabel(emailId);

  for (const email of emailEmails) {
    const mail = await mailById(mails.get(email).ID);

    assert.match(
      mail.Subject,
      new RegExp(`^${sender.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} enviou ".+" para você assinar$`),
    );
  }
});
