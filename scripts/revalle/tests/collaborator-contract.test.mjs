// v.21: contrato para colaboradores (spec 2026-11-23-contrato-colaboradores-design.md). Roda contra a stack local.
//   - o representante assina; "Usar como contrato para colaboradores" (admin) gera o modelo sem as páginas de
//     certificado e de auditoria, com a marca (origem + código de verificação do representante) e o signatário genérico;
//   - a planilha com 3 linhas (uma repetida pelo mesmo e-mail) gera 2 documentos na fila, sem e-mail nenhum;
//   - a varredura (`internal.revalle-collaborator-send-sweep`, disparada como o cron do app dispara: linha em
//     "BackgroundJob" + POST assinado em /api/jobs) envia, e o Mailpit recebe um convite por pessoa;
//   - o colaborador com e-mail da empresa e SEM conta assina sem sessão, com CPF e data de nascimento (pedidos mesmo
//     com o vínculo e-mail ↔ CPF já salvo) e o código por e-mail;
//   - o certificado e o /verificar do colaborador têm "Assinado pela empresa: ... código {código do representante}",
//     com o link para o /verificar do representante; a planilha da situação sai com nome;email;situação;data;
//   - usuário não admin recebe 403 no botão (criar o modelo), no modelo (quadro e "Usar") e no envio em massa marcado.
//
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN, não admin) e REVSIGN_ADMIN_* (ADMIN). Pessoas fictícias de
// revalle/colaboradores/dev-seed.sql. Não importa `account-autologin.mjs`: o colaborador age sem sessão de propósito.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { sessionFor } from './account-helpers.mjs';
import {
  APP_CONTAINER,
  BASE_URL,
  completeWithCode,
  createEnvelope,
  db,
  distribute,
  downloadItem,
  fetchIdempotent,
  mailById,
  mailIdsTo,
  mailsTo,
  poppler,
  signIn,
  trpc,
  trpcAs,
  waitNewMail,
} from './helpers.mjs';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Representante (Beatriz) e colaboradora (Maria): sem e-mail na base do RH, então qualquer e-mail da empresa serve.
const BEATRIZ = { cpf: '68340192787', birthDate: '09/09/1988' };
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const CPFS = [BEATRIZ.cpf, MARIA.cpf].map((cpf) => `'${cpf}'`).join(',');

const repEmail = `contrato-rep-${RUN}@revalle.com.br`;
const colabA = `contrato-colab-a-${RUN}@revalle.com.br`;
const colabB = `contrato-colab-b-${RUN}@revalle.com.br`;
const title = `[TESTE] contrato colaboradores ${RUN}`;
const memberEmail = `contrato-membro-${RUN}@revalle.com.br`;
const memberRowId = `contrato-membro-${RUN}`;

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const data = (res) => res.body?.result?.data?.json;
const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);

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

const pageCount = (dir, name) => Number(poppler(dir, `pdfinfo /pdf/${name}`).match(/^Pages:\s+(\d+)/m)[1]);

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

const gate = async (procedure, input, headers = {}) => {
  const res = await trpc(`revalle.gate.${procedure}`, input, headers);

  return { ...res, state: res.body?.result?.data?.json };
};

const fx = {};

const cleanupLinks = () => {
  db(`delete from "RevalleEmailLink" where cpf in (${CPFS})`);
  db(`delete from "RevalleEmailLink" where email like 'contrato-%-${RUN}@revalle.com.br'`);
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
  fx.adminTeamId = Number(
    db(
      `select t.id from "Team" t join "Organisation" o on o.id = t."organisationId" join "User" u on u.id = o."ownerUserId" where u.email = '${admin.email}' order by t.id limit 1`,
    ),
  );
  fx.dir = mkdtempSync(path.join(tmpdir(), 'contrato-colab-'));

  // O documento do representante nasce no time do admin (o modelo nasce no time do documento). Token do admin: o do
  // ambiente (REVSIGN_SENDER_API_TOKEN) ou um criado agora no time pessoal dele.
  fx.adminToken = process.env.REVSIGN_SENDER_API_TOKEN;

  if (!fx.adminToken) {
    const created = await trpcAs(fx.adminCookie, 'mutation', 'apiToken.create', {
      teamId: fx.adminTeamId,
      tokenName: `contrato-colab-${RUN}`,
      expirationDate: null,
    });

    assert.equal(created.status, 200, created.text);
    fx.adminToken = data(created).token;
  }
});

beforeEach(() => {
  db('delete from "RateLimit"');
});

after(() => {
  cleanupLinks();
  db(`delete from "OrganisationMember" where id = '${memberRowId}'`);

  // A fila deste teste não sai mais em outras varreduras (ex.: do cron da stack).
  if (fx.contractId) {
    db(`update "RevalleCollaboratorContract" set paused = true where id = '${fx.contractId}'`);
  }
});

sessionTest(
  'o representante assina e "Usar como contrato" gera o modelo marcado, sem certificado nem auditoria',
  async () => {
    const created = await createEnvelope({
      recipients: [{ email: repEmail, name: 'Representante' }],
      title,
      apiToken: fx.adminToken,
    });

    assert.equal(created.status, 200, created.text);

    const [rep] = await distribute(created.id, { apiToken: fx.adminToken });

    fx.adminTeamId = Number(db(`select "teamId" from "Envelope" where id = '${created.id}'`));
    const cookie = { Cookie: await sessionFor(repEmail) };
    const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
    const field = created.envelope.fields.find((f) => f.recipientId === rep.id && f.type === 'SIGNATURE');

    await gate('acceptTerm', { token: rep.token, termVersion: '1' }, cookie);
    assert.equal(
      (await gate('verifyIdentity', { token: rep.token, ...BEATRIZ }, cookie)).state?.status,
      'IDENTITY_CONFIRM',
    );
    assert.equal((await gate('confirmIdentity', { token: rep.token, isMe: true }, cookie)).state?.status, 'PASSED');

    const signed = await trpc(
      'envelope.field.sign',
      { token: rep.token, fieldId: field.id, fieldValue: { type: 'SIGNATURE', value: 'Representante' } },
      cookie,
    );

    assert.equal(signed.status, 200, signed.text);

    const done = await completeWithCode({ token: rep.token, documentId, email: repEmail, headers: cookie });

    assert.ok(done.ok, done.text);
    await waitFor(() => status(created.id) === 'COMPLETED', 'a selagem do documento do representante');

    fx.sourceId = created.id;
    fx.repCode = db(`select "verificationCode" from "RevalleSignatureProof" where "recipientId" = ${rep.id}`);
    fx.repName = db(`select employee->>'nome' from "RevalleSignatureProof" where "recipientId" = ${rep.id}`);
    assert.match(fx.repCode, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);

    // Usuário comum: 403 no botão.
    const denied = await trpcAs(fx.userCookie, 'mutation', 'revalle.collaboratorContract.createFromEnvelope', {
      envelopeId: created.id,
      teamId: fx.adminTeamId,
    });

    assert.equal(denied.status, 403, denied.text);

    const res = await trpcAs(fx.adminCookie, 'mutation', 'revalle.collaboratorContract.createFromEnvelope', {
      envelopeId: created.id,
      teamId: fx.adminTeamId,
    });

    assert.equal(res.status, 200, res.text);
    assert.equal(data(res).created, true, res.text);

    fx.templateId = data(res).templateEnvelopeId;

    // De novo: o mesmo modelo (um contrato por documento e time).
    const again = await trpcAs(fx.adminCookie, 'mutation', 'revalle.collaboratorContract.createFromEnvelope', {
      envelopeId: created.id,
      teamId: fx.adminTeamId,
    });

    assert.deepEqual(data(again), { templateEnvelopeId: fx.templateId, created: false });

    const [contractId, sourceEnvelopeId, sourceCode, representativeName] = db(
      `select id || '|' || "sourceEnvelopeId" || '|' || "sourceVerificationCode" || '|' || "representativeName" from "RevalleCollaboratorContract" where "templateEnvelopeId" = '${fx.templateId}'`,
    ).split('|');

    fx.contractId = contractId;
    assert.equal(sourceEnvelopeId, created.id);
    assert.equal(sourceCode, fx.repCode);
    assert.equal(representativeName, fx.repName);
    assert.equal(
      db(`select type || '|' || title || '|' || "teamId" from "Envelope" where id = '${fx.templateId}'`),
      `TEMPLATE|${title}|${fx.adminTeamId}`,
    );
    assert.equal(
      db(`select name || '|' || role from "Recipient" where "envelopeId" = '${fx.templateId}'`),
      'Colaborador|SIGNER',
    );

    // Páginas: as do original, com o carimbo; nenhuma do certificado ou do log.
    const item = created.envelope.envelopeItems[0];

    writeFileSync(
      path.join(fx.dir, 'original.pdf'),
      await downloadItem(item.id, 'original', { apiToken: fx.adminToken }),
    );
    writeFileSync(path.join(fx.dir, 'signed.pdf'), await downloadItem(item.id, 'signed', { apiToken: fx.adminToken }));
    pdfOfItem(fx.templateId, fx.dir, 'template.pdf');

    const originalPages = pageCount(fx.dir, 'original.pdf');

    assert.ok(pageCount(fx.dir, 'signed.pdf') > originalPages, 'o PDF selado deveria ter o certificado');
    assert.equal(pageCount(fx.dir, 'template.pdf'), originalPages);

    const templateText = poppler(fx.dir, 'pdftotext -layout /pdf/template.pdf -');

    assert.ok(!templateText.includes('SHA-256 do original'), 'o modelo levou a página do certificado');
    assert.ok(templateText.includes(fx.repCode), 'o modelo perdeu o carimbo do representante');

    // Sem a assinatura do colaborador no modelo, a planilha é recusada (nada entra na fila).
    const legacyTemplateId = Number(
      db(`select "secondaryId" from "Envelope" where id = '${fx.templateId}'`).replace(/\D/g, ''),
    );
    const early = await trpcAs(
      fx.adminCookie,
      'mutation',
      'template.uploadBulkSend',
      {
        templateId: legacyTemplateId,
        teamId: fx.adminTeamId,
        csv: `recipient_1_email,recipient_1_name\n${colabA},A\n`,
        sendImmediately: false,
      },
      { 'x-team-id': String(fx.adminTeamId) },
    );

    assert.equal(early.status, 400, early.text);
    assert.ok(early.text.includes('Posicione a assinatura do colaborador'), early.text);
    assert.equal(db(`select count(*) from "RevalleBulkSendUpload" where "contractId" = '${fx.contractId}'`), '0');

    // A assinatura do colaborador, como o admin faz no editor.
    const recipientId = Number(db(`select id from "Recipient" where "envelopeId" = '${fx.templateId}'`));
    const fields = await trpcAs(
      fx.adminCookie,
      'mutation',
      'envelope.field.createMany',
      {
        envelopeId: fx.templateId,
        data: [{ recipientId, type: 'SIGNATURE', page: 1, positionX: 10, positionY: 55, width: 30, height: 8 }],
      },
      { 'x-team-id': String(fx.adminTeamId) },
    );

    assert.equal(fields.status, 200, fields.text);
  },
);

sessionTest('a planilha com 3 linhas (uma repetida) gera 2 documentos na fila, sem enviar nada', async () => {
  needs('templateId');

  fx.legacyTemplateId = Number(
    db(`select "secondaryId" from "Envelope" where id = '${fx.templateId}'`).replace(/\D/g, ''),
  );

  const seenA = await mailIdsTo(colabA);
  const seenB = await mailIdsTo(colabB);
  const res = await trpcAs(
    fx.adminCookie,
    'mutation',
    'template.uploadBulkSend',
    {
      templateId: fx.legacyTemplateId,
      teamId: fx.adminTeamId,
      csv: `recipient_1_email,recipient_1_name\n${colabA},Colaboradora A\n${colabB},\n${colabA.toUpperCase()},Repetida\n`,
      sendImmediately: true,
    },
    { 'x-team-id': String(fx.adminTeamId) },
  );

  assert.equal(res.status, 200, res.text);
  assert.deepEqual(data(res), {
    success: true,
    revalleCollaboratorContract: { totalRows: 3, uniqueRows: 2, duplicateRows: 1 },
  });

  await waitFor(
    () =>
      db(
        `select count(*) from "RevalleBulkSendUpload" where "contractId" = '${fx.contractId}' and "completedAt" is not null`,
      ) === '1',
    'a criação dos documentos da planilha',
  );

  const rows = db(
    `select q.status || '|' || e.status || '|' || r.email from "RevalleBulkSendQueue" q join "Envelope" e on e.id = q."envelopeId" join "Recipient" r on r."envelopeId" = e.id where q."contractId" = '${fx.contractId}' order by r.email`,
  )
    .split('\n')
    .filter(Boolean);

  assert.deepEqual(rows, [`QUEUED|DRAFT|${colabA}`, `QUEUED|DRAFT|${colabB}`]);
  assert.equal(
    db(`select count(*) from "User" where email in ('${colabA}', '${colabB}')`),
    '0',
    'colaborador com conta',
  );

  const status = data(
    await trpcAs(fx.adminCookie, 'query', 'revalle.collaboratorContract.getStatus', {
      templateEnvelopeId: fx.templateId,
    }),
  );

  assert.equal(status.counts.totalRows, 3);
  assert.equal(status.counts.duplicateRows, 1);
  assert.equal(status.counts.queued, 2);
  assert.equal(status.counts.sent, 0);

  await sleep(2000);
  assert.equal((await mailsTo(colabA)).filter((m) => !seenA.has(m.ID)).length, 0, 'saiu e-mail antes da varredura');
  assert.equal((await mailsTo(colabB)).filter((m) => !seenB.has(m.ID)).length, 0, 'saiu e-mail antes da varredura');
});

sessionTest('membro do time (não admin) não altera o rascunho na fila nem o modelo marcado', async (t) => {
  needs('contractId');

  const teamRoleGroup = db(
    `select "organisationGroupId" from "TeamGroup" where "teamId" = ${fx.adminTeamId} and "teamRole" = 'ADMIN' order by id limit 1`,
  );

  if (!teamRoleGroup) {
    t.skip('o time do admin não tem o grupo de ADMIN do time');

    return;
  }

  const memberCookie = await sessionFor(memberEmail);
  const memberId = Number(db(`select id from "User" where email = '${memberEmail}'`));
  const orgId = db(`select "organisationId" from "Team" where id = ${fx.adminTeamId}`);

  db(
    `insert into "OrganisationMember" (id, "userId", "organisationId", "updatedAt") values ('${memberRowId}', ${memberId}, '${orgId}', now()) on conflict do nothing`,
  );
  db(
    `insert into "OrganisationGroupMember" (id, "groupId", "organisationMemberId") values ('${memberRowId}-g', '${teamRoleGroup}', '${memberRowId}') on conflict do nothing`,
  );

  const asMember = (kind, procedure, input) =>
    trpcAs(memberCookie, kind, procedure, input, { 'x-team-id': String(fx.adminTeamId) });
  const draft = db(
    `select "envelopeId" from "RevalleBulkSendQueue" where "contractId" = '${fx.contractId}' and email = '${colabB}'`,
  );
  const [itemId, dataId] = db(
    `select id || '|' || "documentDataId" from "EnvelopeItem" where "envelopeId" = '${draft}'`,
  ).split('|');
  const recipientsBefore = db(`select string_agg(email, ',') from "Recipient" where "envelopeId" = '${draft}'`);

  // O membro vê o documento (é admin do time): a recusa vem da regra do contrato, não do acesso.
  assert.equal((await asMember('query', 'envelope.get', { envelopeId: draft })).status, 200);

  for (const [what, res] of [
    [
      'trocar os destinatários do rascunho',
      await asMember('mutation', 'envelope.recipient.set', {
        envelopeId: draft,
        envelopeType: 'DOCUMENT',
        recipients: [{ email: `contrato-outro-${RUN}@revalle.com.br`, name: 'Outro', role: 'SIGNER' }],
      }),
    ],
    [
      'apagar o arquivo do rascunho',
      await asMember('mutation', 'envelope.item.delete', { envelopeId: draft, envelopeItemId: itemId }),
    ],
    ['duplicar o modelo marcado', await asMember('mutation', 'envelope.duplicate', { envelopeId: fx.templateId })],
    ['duplicar o rascunho', await asMember('mutation', 'envelope.duplicate', { envelopeId: draft })],
    [
      'trocar os campos do modelo',
      await asMember('mutation', 'envelope.field.set', {
        envelopeId: fx.templateId,
        envelopeType: 'TEMPLATE',
        fields: [],
      }),
    ],
  ]) {
    assert.equal(res.status, 403, `${what}: HTTP ${res.status} ${res.text}`);
  }

  // Trocar o PDF (multipart, como o editor faz).
  const form = new FormData();

  form.append('payload', JSON.stringify({ envelopeId: draft, envelopeItemId: itemId }));
  form.append('file', new File([readFileSync('assets/example.pdf')], 'outro.pdf', { type: 'application/pdf' }));

  const replaced = await fetch(`${BASE_URL}/api/trpc/envelope.item.replacePdf`, {
    method: 'POST',
    headers: { Origin: new URL(BASE_URL).origin, Cookie: memberCookie, 'x-team-id': String(fx.adminTeamId) },
    body: form,
  });

  assert.notEqual(replaced.status, 200, 'o membro trocou o PDF do rascunho');
  assert.equal(db(`select "documentDataId" from "EnvelopeItem" where id = '${itemId}'`), dataId);
  assert.equal(db(`select string_agg(email, ',') from "Recipient" where "envelopeId" = '${draft}'`), recipientsBefore);
  assert.equal(db(`select count(*) from "Field" where "envelopeId" = '${fx.templateId}'`), '1');
});

sessionTest('pausado, a varredura não envia nada; o contrato fica na fila', async () => {
  needs('contractId');

  const paused = await trpcAs(fx.adminCookie, 'mutation', 'revalle.collaboratorContract.setPaused', {
    templateEnvelopeId: fx.templateId,
    paused: true,
  });

  assert.equal(paused.status, 200, paused.text);
  assert.equal(await sweep(), 'COMPLETED');
  assert.equal(
    db(`select count(*) from "RevalleBulkSendQueue" where "contractId" = '${fx.contractId}' and status = 'QUEUED'`),
    '2',
  );
  assert.equal(
    data(
      await trpcAs(fx.adminCookie, 'query', 'revalle.collaboratorContract.getStatus', {
        templateEnvelopeId: fx.templateId,
      }),
    ).paused,
    true,
  );
});

sessionTest('retomado, a varredura envia a fila e o Mailpit recebe um convite por pessoa', async () => {
  needs('contractId');

  const resumed = await trpcAs(fx.adminCookie, 'mutation', 'revalle.collaboratorContract.setPaused', {
    templateEnvelopeId: fx.templateId,
    paused: false,
  });

  assert.equal(resumed.status, 200, resumed.text);

  const queued = () =>
    db(`select count(*) from "RevalleBulkSendQueue" where "contractId" = '${fx.contractId}' and status = 'QUEUED'`);

  // Outras filas abertas na stack (de rodadas anteriores) podem vir antes: a varredura roda até a nossa sair.
  for (let i = 0; i < 10 && queued() !== '0'; i += 1) {
    assert.equal(await sweep(), 'COMPLETED');
  }

  assert.equal(queued(), '0');
  assert.equal(
    db(`select count(*) from "RevalleBulkSendQueue" where "contractId" = '${fx.contractId}' and status = 'SENT'`),
    '2',
  );

  for (const email of [colabA, colabB]) {
    await waitNewMail(email, new Set(), {
      matches: (mail) => (mail.Subject ?? '').includes(title),
      what: `Convite para ${email}`,
    });

    const invites = [];

    for (const message of await mailsTo(email)) {
      const mail = await mailById(message.ID);

      if ((mail.Subject ?? '').includes(title)) {
        invites.push(mail);
      }
    }

    assert.equal(invites.length, 1, `${email}: ${invites.length} convites`);
  }

  fx.docA = db(
    `select e.id from "RevalleBulkSendQueue" q join "Envelope" e on e.id = q."envelopeId" join "Recipient" r on r."envelopeId" = e.id where q."contractId" = '${fx.contractId}' and r.email = '${colabA}'`,
  );
  assert.equal(status(fx.docA), 'PENDING');
});

sessionTest(
  'colaboradora com e-mail da empresa e sem conta assina com CPF e data (pedidos mesmo com o vínculo salvo)',
  async () => {
    needs('docA');

    const [recipientId, token] = db(
      `select id || '|' || token from "Recipient" where "envelopeId" = '${fx.docA}'`,
    ).split('|');

    // Vínculo e-mail ↔ CPF já salvo: num documento comum ele dispensaria a tela de CPF; aqui não.
    db(`insert into "RevalleEmailLink" (id, email, cpf) values ('contrato-link-${RUN}', '${colabA}', '${MARIA.cpf}')`);

    const page = await fetchIdempotent(`${BASE_URL}/sign/${token}`, { redirect: 'manual' }, async (res) => ({
      status: res.status,
      location: res.headers.get('location'),
    }));

    assert.equal(page.status, 200, `a página de assinatura mandou para ${page.location}`);

    const accepted = await gate('acceptTerm', { token, termVersion: '1' });

    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.state?.status, 'IDENTITY_REQUIRED');
    assert.equal((await gate('verifyIdentity', { token, ...MARIA })).state?.status, 'IDENTITY_CONFIRM');
    assert.equal((await gate('confirmIdentity', { token, isMe: true })).state?.status, 'PASSED');
    assert.equal(
      db(`select "identityStatus" from "RevalleRecipientGate" where "recipientId" = ${recipientId}`),
      'CONFIRMED',
    );

    const fieldId = Number(db(`select id from "Field" where "recipientId" = ${recipientId} and type = 'SIGNATURE'`));
    const signed = await trpc('envelope.field.sign', {
      token,
      fieldId,
      fieldValue: { type: 'SIGNATURE', value: 'Colaboradora A' },
    });

    assert.equal(signed.status, 200, signed.text);

    const documentId = Number(db(`select "secondaryId" from "Envelope" where id = '${fx.docA}'`).replace(/\D/g, ''));
    const done = await completeWithCode({ token, documentId, email: colabA });

    assert.ok(done.ok, done.text);
    await waitFor(() => status(fx.docA) === 'COMPLETED', 'a selagem do documento da colaboradora');

    fx.colabCode = db(`select "verificationCode" from "RevalleSignatureProof" where "recipientId" = ${recipientId}`);
  },
);

sessionTest(
  'certificado e /verificar da colaboradora: "Assinado pela empresa" com o código do representante',
  async () => {
    needs('colabCode');

    pdfOfItem(fx.docA, fx.dir, 'colab.pdf');

    const text = poppler(fx.dir, 'pdftotext -raw /pdf/colab.pdf -').replace(/\s+/g, ' ');

    assert.ok(text.includes(`Assinado pela empresa: ${fx.repName} em `), text.slice(0, 3000));
    assert.ok(text.includes(`código ${fx.repCode}`), 'o certificado não traz o código do representante');

    const page = await fetchIdempotent(`${BASE_URL}/verificar?codigo=${encodeURIComponent(fx.colabCode)}`, {}, (res) =>
      res.text(),
    );

    assert.ok(page.includes('data-testid="verify-company-signature"'), 'o /verificar não mostra a linha da empresa');
    assert.ok(page.includes(`Assinado pela empresa: ${fx.repName} em `));
    assert.ok(page.includes(`href="/verificar?codigo=${fx.repCode}"`), 'sem o link para o /verificar do representante');

    const status = data(
      await trpcAs(fx.adminCookie, 'query', 'revalle.collaboratorContract.getStatus', {
        templateEnvelopeId: fx.templateId,
      }),
    );

    assert.equal(status.counts.sent, 2);
    assert.equal(status.counts.signed, 1);

    const csv = data(
      await trpcAs(fx.adminCookie, 'mutation', 'revalle.collaboratorContract.exportCsv', {
        templateEnvelopeId: fx.templateId,
      }),
    ).csv;
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');

    assert.equal(lines[0], 'nome;email;situação;data');
    assert.equal(lines.length, 3);
    assert.ok(lines.includes(`;${colabB};Enviado;${lines.find((line) => line.includes(colabB))?.split(';')[3]}`), csv);
    assert.ok(
      lines.some((line) => line.includes(`${colabA};Assinado;`)),
      csv,
    );
    assert.ok(!/\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11}/.test(csv), 'a planilha trouxe CPF');
  },
);

sessionTest('usuário não admin: 403 no modelo (quadro e "Usar") e no envio em massa marcado', async () => {
  needs('legacyTemplateId');

  const asUser = await trpcAs(fx.userCookie, 'query', 'revalle.collaboratorContract.getStatus', {
    templateEnvelopeId: fx.templateId,
  });

  assert.equal(asUser.status, 403, asUser.text);

  // O admin perde o papel só aqui (é membro do time do modelo, então o 403 vem da regra, não do acesso ao time).
  db(`update "User" set roles = array['USER']::"Role"[] where email = '${admin.email}'`);

  try {
    const bulk = await trpcAs(
      fx.adminCookie,
      'mutation',
      'template.uploadBulkSend',
      {
        templateId: fx.legacyTemplateId,
        teamId: fx.adminTeamId,
        csv: `recipient_1_email,recipient_1_name\ncontrato-colab-c-${RUN}@revalle.com.br,C\n`,
        sendImmediately: false,
      },
      { 'x-team-id': String(fx.adminTeamId) },
    );

    assert.equal(bulk.status, 403, bulk.text);

    const recipientId = Number(db(`select id from "Recipient" where "envelopeId" = '${fx.templateId}'`));
    const use = await trpcAs(
      fx.adminCookie,
      'mutation',
      'template.createDocumentFromTemplate',
      {
        templateId: fx.legacyTemplateId,
        recipients: [{ id: recipientId, email: `contrato-colab-d-${RUN}@revalle.com.br` }],
      },
      { 'x-team-id': String(fx.adminTeamId) },
    );

    assert.equal(use.status, 403, use.text);

    const panel = await trpcAs(fx.adminCookie, 'query', 'revalle.collaboratorContract.getStatus', {
      templateEnvelopeId: fx.templateId,
    });

    assert.equal(panel.status, 403, panel.text);

    const teamUrl = db(`select url from "Team" where id = ${fx.adminTeamId}`);
    const pageRes = await fetchIdempotent(
      `${BASE_URL}/t/${teamUrl}/templates/${fx.templateId}`,
      { headers: { Cookie: fx.adminCookie }, redirect: 'manual' },
      async (res) => ({ status: res.status }),
    );

    assert.equal(pageRes.status, 302, 'a página do modelo abriu para quem não é admin');
  } finally {
    db(`update "User" set roles = array['USER','ADMIN']::"Role"[] where email = '${admin.email}'`);
  }

  // Com o papel de volta, o modelo marcado abre para o admin (Modelos continua fora da tela).
  const teamUrl = db(`select url from "Team" where id = ${fx.adminTeamId}`);
  const adminPage = await fetchIdempotent(
    `${BASE_URL}/t/${teamUrl}/templates/${fx.templateId}`,
    { headers: { Cookie: fx.adminCookie }, redirect: 'manual' },
    async (res) => ({ status: res.status }),
  );

  assert.equal(adminPage.status, 200, 'a página do modelo marcado não abriu para o admin');

  assert.equal(
    db(`select count(*) from "RevalleBulkSendUpload" where "contractId" = '${fx.contractId}'`),
    '1',
    'a planilha do não admin entrou',
  );
});

sessionTest('duas planilhas iguais ao mesmo tempo: cada e-mail entra na fila uma vez só', async () => {
  needs('legacyTemplateId');

  const emails = ['c', 'd'].map((tag) => `contrato-colab-${tag}-${RUN}@revalle.com.br`);
  const csv = `recipient_1_email,recipient_1_name\n${emails.join(',\n')},\n`;
  const upload = () =>
    trpcAs(
      fx.adminCookie,
      'mutation',
      'template.uploadBulkSend',
      { templateId: fx.legacyTemplateId, teamId: fx.adminTeamId, csv, sendImmediately: false },
      { 'x-team-id': String(fx.adminTeamId) },
    );

  const results = await Promise.all([upload(), upload()]);
  const accepted = results.filter((res) => res.status === 200 && data(res)?.success === true);

  assert.ok(accepted.length >= 1, results.map((res) => res.text).join('\n'));

  for (const res of results.filter((r) => !accepted.includes(r))) {
    assert.ok(res.text.includes('ainda estão sendo criados'), res.text);
  }

  await waitFor(
    () =>
      db(
        `select count(*) from "RevalleBulkSendUpload" where "contractId" = '${fx.contractId}' and "completedAt" is null`,
      ) === '0',
    'a criação dos documentos das planilhas',
  );

  for (const email of emails) {
    assert.equal(
      db(`select count(*) from "RevalleBulkSendQueue" where "contractId" = '${fx.contractId}' and email = '${email}'`),
      '1',
      email,
    );
    assert.equal(
      db(
        `select count(*) from "Envelope" e join "Recipient" r on r."envelopeId" = e.id where e.type = 'DOCUMENT' and e.title = '${title}' and r.email = '${email}'`,
      ),
      '1',
      `${email}: rascunho a mais`,
    );
  }

  // As linhas da planilha saem do banco quando ela termina.
  assert.equal(
    db(
      `select count(*) from "RevalleBulkSendUpload" where "contractId" = '${fx.contractId}' and jsonb_array_length(rows) > 0`,
    ),
    '0',
  );
});
