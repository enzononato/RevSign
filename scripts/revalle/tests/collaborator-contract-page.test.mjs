// v.22: contrato para colaboradores pela página própria (spec 2026-11-23-contrato-colaboradores-pagina-design.md). Roda
// contra a stack local.
//   - só admin: 403 em todas as rotas `revalle.collaboratorContract.page.*` para a conta comum;
//   - o admin cria o contrato pela API da página (rascunho → enviar); o representante recebe o convite com o remetente
//     fixo ("Revalle enviou "{título}" para você assinar") e a resposta para o admin; o documento fica no time
//     "Contratos para colaboradores" do admin;
//   - o representante assina e os documentos entram na fila sozinhos, uma vez só (o job de criação rodado de novo não
//     cria nada); a lista sai do banco;
//   - pausado, a varredura não envia; retomado, envia um convite por colaborador;
//   - "Reenviar" respeita 10 minutos (429 RESEND_TOO_SOON);
//   - a colaboradora assina sem conta com o CPF da lista; outro CPF da base é recusado com o erro comum e conta tentativa;
//   - o certificado traz "Assinado pela empresa"; a planilha da situação traz o CPF mascarado;
//   - o representante recusa: o contrato fica "Recusado pelo representante" e nada entra na fila.
//
// Sessões: REVSIGN_USER_* (admin@hml.local, conta comum) e REVSIGN_ADMIN_* (rsadmin, ADMIN), de bootstrap-creds.mjs.
// Pessoas fictícias de revalle/colaboradores/dev-seed.sql. Nunca imprime CPF, senha nem token.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { sessionFor } from './account-helpers.mjs';
import {
  APP_CONTAINER,
  BASE_URL,
  completeWithCode,
  db,
  fetchIdempotent,
  mailById,
  mailsTo,
  poppler,
  signIn,
  textPdfBuffer,
  trpc,
  trpcAs,
  waitNewMail,
} from './helpers.mjs';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Representante (Beatriz), colaboradoras (Maria e Fernando) e João (outro CPF da base, para a recusa no portão). Todos
// ativos e sem e-mail na base do RH.
const BEATRIZ = { cpf: '68340192787', birthDate: '09/09/1988' };
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const FERNANDO = { cpf: '93457210888', birthDate: '31/12/1999' };
const JOAO = { cpf: '52871936455', birthDate: '20/11/1985' };
const CPFS = [BEATRIZ, MARIA, FERNANDO, JOAO].map(({ cpf }) => `'${cpf}'`).join(',');
// CPF válido que não está na base: a linha não entra.
const NOT_IN_BASE_CPF = '529.982.247-25';

const repEmail = `contrato-pag-rep-${RUN}@revalle.com.br`;
const rep2Email = `contrato-pag-rep2-${RUN}@revalle.com.br`;
const colabA = `contrato-pag-a-${RUN}@revalle.com.br`;
const colabB = `contrato-pag-b-${RUN}@revalle.com.br`;
const colabOut = `contrato-pag-fora-${RUN}@revalle.com.br`;
const title = `[TESTE] contrato página ${RUN}`;
const rejectedTitle = `[TESTE] contrato recusado ${RUN}`;

const REP_RECT = { page: 1, positionX: 10, positionY: 70, width: 30, height: 8 };
const COLAB_RECT = { page: 1, positionX: 55, positionY: 70, width: 30, height: 8 };

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const data = (res) => res.body?.result?.data?.json;
const envelopeStatus = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);
const contractStatus = (contractId) =>
  db(`select status from "RevalleCollaboratorContract" where id = '${contractId}'`);
const queueCount = (contractId, status) =>
  Number(
    db(
      `select count(*) from "RevalleBulkSendQueue" where "contractId" = '${contractId}'${status ? ` and status = '${status}'` : ''}`,
    ),
  );

const page = (kind, procedure, input, cookie) =>
  trpcAs(cookie, kind, `revalle.collaboratorContract.page.${procedure}`, input);

const waitFor = async (check, what, timeoutMs = 120_000) => {
  const deadline = performance.now() + timeoutMs;

  while (performance.now() < deadline) {
    if (check()) {
      return;
    }

    await sleep(1000);
  }

  assert.fail(`${what} não aconteceu em ${timeoutMs / 1000} s`);
};

// O PDF guardado no banco (NEXT_PUBLIC_UPLOAD_TRANSPORT=database) pode passar do buffer padrão de `db`.
const pdfOfItem = (envelopeId, dir, name) => {
  const base64 = execFileSync(
    'docker',
    [
      'exec',
      'revsign-hml-database-1',
      'psql',
      '-U',
      'documenso',
      '-d',
      'documenso',
      '-At',
      '-c',
      `select d.data from "DocumentData" d join "EnvelopeItem" i on i."documentDataId" = d.id where i."envelopeId" = '${envelopeId}' order by i."order" limit 1`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).trim();

  writeFileSync(path.join(dir, name), Buffer.from(base64, 'base64'));
};

// Dispara um job como o cron do app (linha em BackgroundJob + POST assinado com a chave do container).
const runJobLikeTheApp = async ({ jobId, name, version, payload }) => {
  const options = { name: jobId, payload };
  const script = `
    const crypto = require('node:crypto');
    const { xchacha20poly1305 } = require('@noble/ciphers/chacha');
    const { managedNonce } = require('@noble/ciphers/webcrypto');
    const { bytesToHex, utf8ToBytes } = require('@noble/ciphers/utils');
    const { sha256 } = require('@noble/hashes/sha2');
    const hashed = crypto.createHash('sha512').update(process.argv[1]).digest('hex');
    const key = sha256(process.env.NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY);
    const sealed = managedNonce(xchacha20poly1305)(key).encrypt(utf8ToBytes(JSON.stringify({ data: hashed })));
    process.stdout.write(bytesToHex(sealed));
  `;
  const signature = execFileSync('docker', ['exec', APP_CONTAINER, 'node', '-e', script, JSON.stringify(options)], {
    encoding: 'utf8',
  }).trim();
  const id = `revsign-test-${jobId}-${RUN}-${Date.now()}`;

  db(
    `insert into "BackgroundJob" (id, "jobId", name, version, payload, "updatedAt") values ('${id}', '${jobId}', '${name}', '${version}', '${JSON.stringify(payload)}', now())`,
  );

  const res = await fetch(`${BASE_URL}/api/jobs/${jobId}/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Job-Id': id, 'X-Job-Signature': signature },
    body: JSON.stringify(options),
  });

  assert.equal(res.status, 200, `job ${jobId}: HTTP ${res.status} ${await res.text()}`);

  return db(`select status from "BackgroundJob" where id = '${id}'`);
};

const sweep = () =>
  runJobLikeTheApp({
    jobId: 'internal.revalle-collaborator-send-sweep',
    name: 'Revalle Collaborator Send Sweep',
    version: '1.0.0',
    payload: {},
  });

const build = (contractId) =>
  runJobLikeTheApp({
    jobId: 'internal.revalle-collaborator-contract-build',
    name: 'Revalle Collaborator Contract Build',
    version: '1.0.0',
    payload: { contractId },
  });

const gate = async (procedure, input, headers = {}) => {
  const res = await trpc(`revalle.gate.${procedure}`, input, headers);

  return { ...res, state: res.body?.result?.data?.json };
};

// O PDF do assistente, pelo mesmo upload da tela (`/api/files/upload-pdf`).
const uploadPdf = async (cookie, lines) => {
  const form = new FormData();

  form.append('file', new File([textPdfBuffer(lines)], 'contrato.pdf', { type: 'application/pdf' }));

  const res = await fetch(`${BASE_URL}/api/files/upload-pdf`, {
    method: 'POST',
    headers: { Origin: new URL(BASE_URL).origin, Cookie: cookie },
    body: form,
  });

  assert.equal(res.status, 200, `upload: HTTP ${res.status}`);

  return (await res.json()).id;
};

// O representante passa o portão (termo, CPF e data, confirmação) com a sessão da conta dele.
const passGateAsRepresentative = async (token, cookie) => {
  await gate('acceptTerm', { token, termVersion: '1' }, cookie);
  assert.equal((await gate('verifyIdentity', { token, ...BEATRIZ }, cookie)).state?.status, 'IDENTITY_CONFIRM');
  assert.equal((await gate('confirmIdentity', { token, isMe: true }, cookie)).state?.status, 'PASSED');
};

const recipientOf = (envelopeId) => {
  const [id, token] = db(`select id || '|' || token from "Recipient" where "envelopeId" = '${envelopeId}'`).split('|');

  return { id: Number(id), token };
};

const documentIdOf = (envelopeId) =>
  Number(db(`select "secondaryId" from "Envelope" where id = '${envelopeId}'`).replace(/\D/g, ''));

const queueRowOf = (contractId, email) => {
  const [queueId, envelopeId] = db(
    `select id || '|' || "envelopeId" from "RevalleBulkSendQueue" where "contractId" = '${contractId}' and email = '${email}'`,
  ).split('|');

  return { queueId, envelopeId };
};

const replyToOf = (mail) => (mail.ReplyTo ?? []).map((address) => address.Address.toLowerCase());

const invitesTo = async (email, matchTitle) => {
  const invites = [];

  for (const message of await mailsTo(email)) {
    const mail = await mailById(message.ID);

    if ((mail.Subject ?? '').includes(`"${matchTitle}"`)) {
      invites.push(mail);
    }
  }

  return invites;
};

const fx = {};

const cleanupLinks = () => {
  db(`delete from "RevalleEmailLink" where cpf in (${CPFS})`);
  db(`delete from "RevalleEmailLink" where email like 'contrato-pag-%-${RUN}@revalle.com.br'`);
};

const sessionTest = (name, fn) =>
  test(name, async (t) => {
    if (!fx.adminCookie) {
      t.skip('credenciais de sessão não informadas (REVSIGN_USER_*, REVSIGN_ADMIN_*)');

      return;
    }

    await fn(t);
  });

const needs = (key) => assert.ok(fx[key], `depende do caso anterior (${key})`);

before(async () => {
  cleanupLinks();

  if (!user.email || !user.password || !admin.email || !admin.password) {
    return;
  }

  fx.userCookie = await signIn(user.email, user.password);
  fx.adminCookie = await signIn(admin.email, admin.password);
  fx.adminId = Number(db(`select id from "User" where email = '${admin.email}'`));
  fx.dir = mkdtempSync(path.join(tmpdir(), 'contrato-pagina-'));
});

beforeEach(() => {
  db('delete from "RateLimit"');
});

after(() => {
  cleanupLinks();

  // A fila deste teste não sai mais em outras varreduras (ex.: do cron da stack).
  for (const contractId of [fx.contractId, fx.rejectedContractId].filter(Boolean)) {
    db(`update "RevalleCollaboratorContract" set paused = true where id = '${contractId}'`);
  }
});

sessionTest('não admin: 403 em todas as rotas da página', async () => {
  const id = 'contrato-inexistente';
  const calls = [
    ['query', 'list', {}],
    ['query', 'get', { contractId: id }],
    ['query', 'rows', { contractId: id }],
    ['mutation', 'saveDraft', { data: { title: 'x' } }],
    [
      'mutation',
      'create',
      {
        title: 'x',
        documentDataId: 'x',
        representativeEmail: repEmail,
        representativeRect: REP_RECT,
        collaboratorRect: COLAB_RECT,
        rows: [{ name: 'A', email: colabA, cpf: MARIA.cpf }],
      },
    ],
    ['mutation', 'resend', { contractId: id, queueId: 'x' }],
    ['mutation', 'resendRepresentative', { contractId: id }],
    ['mutation', 'setPaused', { contractId: id, paused: true }],
    ['mutation', 'exportCsv', { contractId: id }],
    ['mutation', 'previewRows', { text: `Maria;${colabA};${MARIA.cpf}` }],
  ];

  for (const [kind, procedure, input] of calls) {
    const res = await page(kind, procedure, input, fx.userCookie);

    assert.equal(res.status, 403, `${procedure}: HTTP ${res.status} ${res.text}`);
  }

  assert.equal(
    db(`select count(*) from "RevalleCollaboratorContract" where title = 'x' and "createdById" <> ${fx.adminId}`),
    '0',
  );
});

sessionTest('admin cria o contrato e o representante recebe o convite com o remetente fixo', async () => {
  const documentDataId = await uploadPdf(fx.adminCookie, ['Contrato de teste da página', RUN]);

  // O assistente grava o rascunho; enviar usa o mesmo contrato.
  const draft = await page('mutation', 'saveDraft', { data: { title, representativeRect: REP_RECT } }, fx.adminCookie);

  assert.equal(draft.status, 200, draft.text);
  fx.contractId = data(draft).contractId;
  assert.equal(contractStatus(fx.contractId), 'DRAFT');

  const seenRep = new Set((await mailsTo(repEmail)).map((message) => message.ID));
  const input = {
    contractId: fx.contractId,
    title,
    documentDataId,
    representativeEmail: repEmail,
    representativeRect: REP_RECT,
    collaboratorRect: COLAB_RECT,
    rows: [
      { name: 'Maria digitada', email: colabA, cpf: '390.533.447-05' },
      { name: 'Fernando', email: colabB.toUpperCase(), cpf: FERNANDO.cpf },
      { name: 'Fora da base', email: colabOut, cpf: NOT_IN_BASE_CPF },
      { name: 'Maria de novo', email: `contrato-pag-dup-${RUN}@revalle.com.br`, cpf: MARIA.cpf },
    ],
  };

  const res = await page('mutation', 'create', input, fx.adminCookie);

  assert.equal(res.status, 200, res.text);
  assert.deepEqual(data(res), { contractId: fx.contractId });

  // O segundo clique não envia de novo.
  const again = await page('mutation', 'create', input, fx.adminCookie);

  assert.equal(again.status, 409, again.text);

  const [status, repEnvelopeId, teamUrl, senderName] = db(
    `select c.status || '|' || c."representativeEnvelopeId" || '|' || t.url || '|' || c."senderName" from "RevalleCollaboratorContract" c join "Team" t on t.id = c."teamId" where c.id = '${fx.contractId}'`,
  ).split('|');

  assert.equal(status, 'AWAITING_REPRESENTATIVE');
  assert.equal(teamUrl, `contratos-colab-${fx.adminId}`);
  assert.equal(senderName, 'Revalle');
  assert.equal(envelopeStatus(repEnvelopeId), 'PENDING');
  fx.repEnvelopeId = repEnvelopeId;

  // Só as 2 linhas prontas ficam guardadas (fora da base e repetida não entram); nada na fila ainda.
  assert.equal(
    db(
      `select string_agg(r->>'email', ',' order by r->>'email') from "RevalleBulkSendUpload" u, jsonb_array_elements(u.rows) r where u."contractId" = '${fx.contractId}'`,
    ),
    [colabA, colabB].sort().join(','),
  );
  assert.equal(queueCount(fx.contractId), 0);

  const invite = await waitNewMail(repEmail, seenRep, {
    matches: (mail) => (mail.Subject ?? '').includes(title),
    what: 'convite do representante',
  });

  assert.ok(invite.Subject.startsWith('Revalle enviou "'), invite.Subject);
  assert.deepEqual(replyToOf(invite), [admin.email.toLowerCase()]);

  // O time do contrato não aparece para a conta comum (nem é dela).
  const session = await trpcAs(fx.userCookie, 'query', 'organisation.internal.getOrganisationSession', undefined);

  assert.ok(!JSON.stringify(data(session) ?? []).includes('contratos-colab-'), 'o time do contrato apareceu');
});

sessionTest('conclusão do representante cria os documentos uma vez só', async () => {
  needs('repEnvelopeId');

  const rep = recipientOf(fx.repEnvelopeId);
  const cookie = { Cookie: await sessionFor(repEmail) };
  const fieldId = Number(db(`select id from "Field" where "recipientId" = ${rep.id} and type = 'SIGNATURE'`));

  await passGateAsRepresentative(rep.token, cookie);

  const signed = await trpc(
    'envelope.field.sign',
    { token: rep.token, fieldId, fieldValue: { type: 'SIGNATURE', value: 'Representante' } },
    cookie,
  );

  assert.equal(signed.status, 200, signed.text);

  const done = await completeWithCode({
    token: rep.token,
    documentId: documentIdOf(fx.repEnvelopeId),
    email: repEmail,
    headers: cookie,
  });

  assert.ok(done.ok, done.text);
  await waitFor(() => envelopeStatus(fx.repEnvelopeId) === 'COMPLETED', 'a selagem do documento do representante');
  await waitFor(
    () =>
      queueCount(fx.contractId) === 2 &&
      db(
        `select count(*) from "RevalleBulkSendUpload" where "contractId" = '${fx.contractId}' and "completedAt" is null`,
      ) === '0',
    'a criação dos documentos dos colaboradores',
  );

  fx.repCode = db(`select "verificationCode" from "RevalleSignatureProof" where "recipientId" = ${rep.id}`);
  fx.repName = db(`select employee->>'nome' from "RevalleSignatureProof" where "recipientId" = ${rep.id}`);

  // O mesmo evento de novo (duas vezes): nada a mais.
  assert.equal(await build(fx.contractId), 'COMPLETED');
  assert.equal(await build(fx.contractId), 'COMPLETED');

  assert.equal(queueCount(fx.contractId), 2);
  assert.equal(queueCount(fx.contractId, 'QUEUED'), 2);
  assert.equal(contractStatus(fx.contractId), 'SENDING');
  assert.equal(
    db(`select count(*) from "Envelope" where type = 'TEMPLATE' and title = '${title}' and "teamId" is not null`),
    '1',
  );

  for (const email of [colabA, colabB]) {
    assert.equal(
      db(
        `select count(*) from "Envelope" e join "Recipient" r on r."envelopeId" = e.id where e.type = 'DOCUMENT' and e.title = '${title}' and r.email = '${email}'`,
      ),
      '1',
      `${email}: documentos`,
    );
  }

  // A fila guarda o CPF da lista e o nome do RH; a lista sai do banco.
  assert.equal(
    db(
      `select (cpf = '${MARIA.cpf}')::text || '|' || name from "RevalleBulkSendQueue" where "contractId" = '${fx.contractId}' and email = '${colabA}'`,
    ),
    'true|Maria Teste da Silva',
  );
  assert.equal(
    db(
      `select count(*) from "RevalleBulkSendUpload" where "contractId" = '${fx.contractId}' and jsonb_array_length(rows) > 0`,
    ),
    '0',
  );

  // Os documentos estão no time do contrato, com a assinatura no quadro verde.
  const { envelopeId } = queueRowOf(fx.contractId, colabA);

  assert.equal(
    db(
      `select t.url || '|' || f.page || '|' || round(f."positionX"::numeric) from "Envelope" e join "Team" t on t.id = e."teamId" join "Field" f on f."envelopeId" = e.id where e.id = '${envelopeId}' and f.type = 'SIGNATURE'`,
    ),
    `contratos-colab-${fx.adminId}|1|55`,
  );
});

sessionTest('pausar e retomar', async () => {
  needs('repCode');

  const paused = await page('mutation', 'setPaused', { contractId: fx.contractId, paused: true }, fx.adminCookie);

  assert.equal(paused.status, 200, paused.text);
  assert.equal(await sweep(), 'COMPLETED');
  assert.equal(queueCount(fx.contractId, 'QUEUED'), 2);
  assert.equal(
    data(await page('query', 'get', { contractId: fx.contractId }, fx.adminCookie)).contract.status,
    'PAUSED',
  );

  const resumed = await page('mutation', 'setPaused', { contractId: fx.contractId, paused: false }, fx.adminCookie);

  assert.equal(resumed.status, 200, resumed.text);
  assert.equal(
    data(await page('query', 'get', { contractId: fx.contractId }, fx.adminCookie)).contract.status,
    'SENDING',
  );
});

sessionTest('varredura envia um convite por colaborador', async () => {
  needs('repCode');

  // Outras filas abertas na stack (de rodadas anteriores) podem vir antes: a varredura roda até a nossa sair.
  for (let i = 0; i < 10 && queueCount(fx.contractId, 'QUEUED') > 0; i += 1) {
    assert.equal(await sweep(), 'COMPLETED');
  }

  assert.equal(queueCount(fx.contractId, 'SENT'), 2);

  for (const email of [colabA, colabB]) {
    await waitNewMail(email, new Set(), {
      matches: (mail) => (mail.Subject ?? '').includes(title),
      what: `convite para ${email}`,
    });

    const invites = await invitesTo(email, title);

    assert.equal(invites.length, 1, `${email}: ${invites.length} convites`);
    assert.ok(invites[0].Subject.startsWith('Revalle enviou "'), invites[0].Subject);
    assert.deepEqual(replyToOf(invites[0]), [admin.email.toLowerCase()]);
  }

  const rows = data(
    await page('query', 'rows', { contractId: fx.contractId, filter: 'SENT', search: 'maria' }, fx.adminCookie),
  );

  assert.equal(rows.total, 1);
  assert.equal(rows.rows[0].email, colabA);
  assert.equal(rows.rows[0].cpfMasked, '***.533.447-**');
});

sessionTest('reenviar respeita 10 minutos', async () => {
  needs('repCode');

  const { queueId } = queueRowOf(fx.contractId, colabB);
  const seen = new Set((await mailsTo(colabB)).map((message) => message.ID));
  const resend = () => page('mutation', 'resend', { contractId: fx.contractId, queueId }, fx.adminCookie);

  const first = await resend();

  assert.equal(first.status, 200, first.text);
  await waitNewMail(colabB, seen, {
    matches: (mail) => (mail.Subject ?? '').includes(`Revalle enviou "${title}"`),
    what: 'o reenvio',
  });

  const tooSoon = await resend();

  assert.equal(tooSoon.status, 429, tooSoon.text);
  assert.ok(tooSoon.text.includes('RESEND_TOO_SOON'), tooSoon.text);

  // Passados 10 minutos, pode de novo.
  db(`update "RevalleBulkSendQueue" set "resentAt" = now() - interval '11 minutes' where id = '${queueId}'`);
  assert.equal((await resend()).status, 200);
});

sessionTest('colaborador assina com o CPF da lista; outro CPF da base é recusado', async () => {
  needs('repCode');

  const { envelopeId } = queueRowOf(fx.contractId, colabA);
  const colab = recipientOf(envelopeId);

  // Sem conta: a página de assinatura abre sem sessão.
  const signPage = await fetchIdempotent(`${BASE_URL}/sign/${colab.token}`, { redirect: 'manual' }, async (res) => ({
    status: res.status,
  }));

  assert.equal(signPage.status, 200);

  const accepted = await gate('acceptTerm', { token: colab.token, termVersion: '1' });

  assert.equal(accepted.state?.status, 'IDENTITY_REQUIRED', accepted.text);

  const attemptsLeft = accepted.state.attemptsLeft;

  // João existe na base, com CPF e data certos, mas não é o CPF da lista: o erro comum, e a tentativa conta.
  const other = await gate('verifyIdentity', { token: colab.token, ...JOAO });

  assert.equal(other.state?.status, 'IDENTITY_REQUIRED', other.text);
  assert.equal(other.state?.attemptsLeft, attemptsLeft - 1);
  assert.ok(!other.text.includes('João'), 'o portão revelou dado de outra pessoa');

  assert.equal((await gate('verifyIdentity', { token: colab.token, ...MARIA })).state?.status, 'IDENTITY_CONFIRM');
  assert.equal((await gate('confirmIdentity', { token: colab.token, isMe: true })).state?.status, 'PASSED');

  // Nenhum vínculo e-mail ↔ CPF nasce do contrato.
  assert.equal(db(`select count(*) from "RevalleEmailLink" where email = '${colabA}'`), '0');

  const fieldId = Number(db(`select id from "Field" where "recipientId" = ${colab.id} and type = 'SIGNATURE'`));
  const signed = await trpc('envelope.field.sign', {
    token: colab.token,
    fieldId,
    fieldValue: { type: 'SIGNATURE', value: 'Maria' },
  });

  assert.equal(signed.status, 200, signed.text);

  const done = await completeWithCode({ token: colab.token, documentId: documentIdOf(envelopeId), email: colabA });

  assert.ok(done.ok, done.text);
  await waitFor(() => envelopeStatus(envelopeId) === 'COMPLETED', 'a selagem do documento da colaboradora');

  fx.docA = envelopeId;
});

sessionTest('certificado traz a linha Assinado pela empresa', async () => {
  needs('docA');

  pdfOfItem(fx.docA, fx.dir, 'colab.pdf');

  const text = poppler(fx.dir, 'pdftotext -raw /pdf/colab.pdf -').replace(/\s+/g, ' ');

  assert.ok(text.includes(`Assinado pela empresa: ${fx.repName} em `), 'o certificado não traz a linha da empresa');
  assert.ok(text.includes(`código ${fx.repCode}`), 'o certificado não traz o código do representante');

  const csv = data(await page('mutation', 'exportCsv', { contractId: fx.contractId }, fx.adminCookie)).csv;
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');

  assert.equal(lines[0], 'nome;email;CPF;situação;data');
  assert.ok(
    lines.some((line) => line.startsWith(`Maria Teste da Silva;${colabA};***.533.447-**;Assinado;`)),
    'linha da Maria',
  );
  assert.ok(!/\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11}/.test(csv), 'a planilha trouxe CPF completo');

  const summary = data(await page('query', 'get', { contractId: fx.contractId }, fx.adminCookie));

  assert.equal(summary.counts.signed, 1);
  assert.equal(summary.representative.status, 'SIGNED');
});

sessionTest('representante recusa: nada entra na fila', async () => {
  // O vínculo da Beatriz com o primeiro representante sairia como conflito no portão do segundo e-mail.
  cleanupLinks();

  const documentDataId = await uploadPdf(fx.adminCookie, ['Contrato recusado', RUN]);
  const res = await page(
    'mutation',
    'create',
    {
      title: rejectedTitle,
      senderName: 'RH Revalle',
      documentDataId,
      representativeEmail: rep2Email,
      representativeRect: REP_RECT,
      collaboratorRect: COLAB_RECT,
      rows: [{ name: 'Fernando', email: colabB, cpf: FERNANDO.cpf }],
    },
    fx.adminCookie,
  );

  assert.equal(res.status, 200, res.text);
  fx.rejectedContractId = data(res).contractId;

  const repEnvelopeId = db(
    `select "representativeEnvelopeId" from "RevalleCollaboratorContract" where id = '${fx.rejectedContractId}'`,
  );
  const invite = await waitNewMail(rep2Email, new Set(), {
    matches: (mail) => (mail.Subject ?? '').includes(rejectedTitle),
    what: 'convite do segundo representante',
  });

  assert.ok(invite.Subject.startsWith('RH Revalle enviou "'), invite.Subject);

  const rep = recipientOf(repEnvelopeId);
  const cookie = { Cookie: await sessionFor(rep2Email) };

  await passGateAsRepresentative(rep.token, cookie);

  const refusal = await trpc(
    'recipient.rejectDocumentWithToken',
    { token: rep.token, documentId: documentIdOf(repEnvelopeId), reason: 'Teste' },
    cookie,
  );

  assert.equal(refusal.status, 200, refusal.text);
  await waitFor(
    () => contractStatus(fx.rejectedContractId) === 'REJECTED_BY_REPRESENTATIVE',
    'o contrato ficar recusado',
  );

  // Nem o job de criação rodado de novo põe alguém na fila.
  assert.equal(await build(fx.rejectedContractId), 'COMPLETED');
  assert.equal(queueCount(fx.rejectedContractId), 0);
  assert.equal(
    db(
      `select coalesce("templateEnvelopeId", '-') from "RevalleCollaboratorContract" where id = '${fx.rejectedContractId}'`,
    ),
    '-',
  );
  assert.equal(
    db(
      `select count(*) from "RevalleBulkSendUpload" where "contractId" = '${fx.rejectedContractId}' and jsonb_array_length(rows) > 0`,
    ),
    '0',
  );
  assert.equal(
    data(await page('query', 'get', { contractId: fx.rejectedContractId }, fx.adminCookie)).contract.status,
    'REJECTED_BY_REPRESENTATIVE',
  );
});
