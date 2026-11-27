// v.26: inativação pela folha (spec 2026-11-27-unidades-times-acesso-design.md, "Inativação pelo RH"). Roda contra a
// stack local.
//   - a varredura (`internal.revalle-hr-inactivation-sweep`, disparada como o cron do app dispara: linha em
//     "BackgroundJob" + POST assinado em /api/jobs) desativa a conta com CPF vinculado que a folha mostra desligada,
//     encerra as sessões dela e registra INACTIVATED/HR_SYNC;
//   - não toca a conta com CPF ativo, a conta sem vínculo e a conta "Mantido ativo pelo TI";
//   - com a base do RH fora do ar, não faz nada;
//   - "Reativar" (admin) reativa, liga "Mantido ativo pelo TI" e registra quem reativou: a folha não desativa de novo;
//     desligar a marca devolve a conta à folha;
//   - "Zerar autenticador" (o reset de 2FA do upstream) registra TOTP_RESET com quem zerou; não admin recebe 403.
//
// Pessoas FICTÍCIAS 11 a 13 de revalle/colaboradores/dev-seed.sql (bloco inativacao-folha), exclusivas deste teste: o
// bloco idempotente é aplicado na base de teste do RH antes de começar. Sessões: REVSIGN_USER_* (não admin) e
// REVSIGN_ADMIN_* (ADMIN). A varredura é global: qualquer conta da stack com CPF desligado também é desativada.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { before, test } from 'node:test';

import { ensureTestAccount, sessionFor } from './account-helpers.mjs';
import { APP_CONTAINER, BASE_URL, db, signIn, trpcAs } from './helpers.mjs';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const DISMISSED_1 = '42000000169';
const DISMISSED_2 = '42000000240';
const ACTIVE = '42000000320';
const CPFS = [DISMISSED_1, DISMISSED_2, ACTIVE].map((cpf) => `'${cpf}'`).join(',');

const COMPOSE = ['compose', '-f', 'revalle/deploy/compose.hml.yml', '--env-file', '../local-hml/hml.env'];
const compose = (...args) => execFileSync('docker', [...COMPOSE, ...args], { stdio: 'ignore' });

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const baseSql = (query) =>
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'revsign-hml-colaboradores-db-1',
      'psql',
      '-U',
      'postgres',
      '-d',
      'colaboradores',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { encoding: 'utf8', input: query },
  ).trim();

const waitForBase = async () => {
  compose('start', 'colaboradores-db');

  for (let i = 0; i < 40; i += 1) {
    try {
      execFileSync('docker', ['exec', 'revsign-hml-colaboradores-db-1', 'pg_isready', '-q'], { stdio: 'ignore' });

      return;
    } catch {
      await sleep(500);
    }
  }

  throw new Error('colaboradores-db não ficou pronto a tempo');
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
    jobId: 'internal.revalle-hr-inactivation-sweep',
    name: 'Revalle HR Inactivation Sweep',
    version: '1.0.0',
    payload: {},
  });

const idOf = (email) => Number(db(`select id from "User" where email = ${sql(email)}`));
const isDisabled = (id) => db(`select disabled from "User" where id = ${id}`) === 't';
const eventsOf = (id) =>
  db(
    `select action || '|' || source || '|' || coalesce("actorId"::text, '') from "RevalleUserStatusEvent" where "userId" = ${id} order by "createdAt", id`,
  )
    .split('\n')
    .filter(Boolean);
const link = (email, cpf) =>
  db(
    `insert into "RevalleEmailLink" (id, email, cpf) values (${sql(`folha-${RUN}-${cpf}`)}, ${sql(email)}, ${sql(cpf)})`,
  );

const fx = {};

before(async () => {
  assert.ok(admin.email && admin.password && user.email && user.password, 'defina REVSIGN_ADMIN_* e REVSIGN_USER_*');

  await waitForBase();

  // Bloco idempotente do dev-seed (só a base FICTÍCIA de teste do RH).
  const seed = readFileSync('revalle/colaboradores/dev-seed.sql', 'utf8');
  const block = seed.match(/-- inativacao-folha:inicio\n([\s\S]*?)-- inativacao-folha:fim/)?.[1];

  assert.ok(block, 'bloco inativacao-folha ausente do dev-seed.sql');
  baseSql(block);

  // CPFs exclusivos deste teste: os vínculos de execuções anteriores saem (o vínculo é único por CPF).
  db(`delete from "RevalleEmailLink" where cpf in (${CPFS})`);

  fx.dismissed = ensureTestAccount(`folha-desligado-${RUN}@revalle.com.br`, 'Teste Folha Desligado');
  fx.kept = ensureTestAccount(`folha-mantido-${RUN}@revalle.com.br`, 'Teste Folha Mantido');
  fx.active = ensureTestAccount(`folha-ativo-${RUN}@revalle.com.br`, 'Teste Folha Ativo');
  fx.unlinked = ensureTestAccount(`folha-sem-vinculo-${RUN}@revalle.com.br`, 'Teste Folha Sem Vínculo');

  link(fx.dismissed, DISMISSED_1);
  link(fx.kept, DISMISSED_2);
  link(fx.active, ACTIVE);

  fx.adminId = idOf(admin.email.trim().toLowerCase());
  fx.dismissedId = idOf(fx.dismissed);
  fx.keptId = idOf(fx.kept);
  fx.activeId = idOf(fx.active);
  fx.unlinkedId = idOf(fx.unlinked);

  db(`insert into "RevalleUserKeepActive" ("userId", "setById") values (${fx.keptId}, ${fx.adminId})`);

  // Sessão aberta da pessoa desligada: a inativação encerra.
  await sessionFor(fx.dismissed);
  assert.notEqual(db(`select count(*) from "Session" where "userId" = ${fx.dismissedId}`), '0');

  fx.adminCookie = await signIn(admin.email, admin.password);
  fx.userCookie = await signIn(user.email, user.password);
});

test('base do RH fora do ar: ninguém é inativado', async (t) => {
  compose('stop', 'colaboradores-db');
  t.after(waitForBase);

  assert.equal(await sweep(), 'COMPLETED');
  assert.equal(isDisabled(fx.dismissedId), false);
  assert.deepEqual(eventsOf(fx.dismissedId), []);
});

test('desligado com vínculo é inativado; ativo, sem vínculo e mantido ativo não', async () => {
  assert.equal(await sweep(), 'COMPLETED');

  assert.equal(isDisabled(fx.dismissedId), true);
  assert.deepEqual(eventsOf(fx.dismissedId), ['INACTIVATED|HR_SYNC|']);
  assert.equal(db(`select count(*) from "Session" where "userId" = ${fx.dismissedId}`), '0');

  for (const id of [fx.activeId, fx.unlinkedId, fx.keptId]) {
    assert.equal(isDisabled(id), false);
    assert.deepEqual(eventsOf(id), []);
  }

  const status = await trpcAs(fx.adminCookie, 'query', 'admin.user.revalle.status', { userId: fx.dismissedId });

  assert.equal(status.status, 200);
  assert.deepEqual(status.body.result.data.json, { disabled: true, hrInactivated: true, keepActive: false });
});

test('Reativar: reativa, liga "Mantido ativo pelo TI" e a folha não desativa de novo', async () => {
  const denied = await trpcAs(fx.userCookie, 'mutation', 'admin.user.revalle.reactivate', { userId: fx.dismissedId });

  assert.equal(denied.status, 401, denied.text);
  assert.equal(isDisabled(fx.dismissedId), true);

  const res = await trpcAs(fx.adminCookie, 'mutation', 'admin.user.revalle.reactivate', { userId: fx.dismissedId });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(isDisabled(fx.dismissedId), false);
  assert.equal(
    db(`select "setById" from "RevalleUserKeepActive" where "userId" = ${fx.dismissedId}`),
    String(fx.adminId),
  );
  assert.deepEqual(eventsOf(fx.dismissedId), [
    'INACTIVATED|HR_SYNC|',
    `REACTIVATED|ADMIN|${fx.adminId}`,
    `KEPT_ACTIVE_ON|ADMIN|${fx.adminId}`,
  ]);

  assert.equal(await sweep(), 'COMPLETED');
  assert.equal(isDisabled(fx.dismissedId), false);

  // Sem a marca, a conta volta para a folha.
  const off = await trpcAs(fx.adminCookie, 'mutation', 'admin.user.revalle.setKeepActive', {
    userId: fx.dismissedId,
    keepActive: false,
  });

  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(await sweep(), 'COMPLETED');
  assert.equal(isDisabled(fx.dismissedId), true);
  assert.deepEqual(eventsOf(fx.dismissedId).slice(-2), [`KEPT_ACTIVE_OFF|ADMIN|${fx.adminId}`, 'INACTIVATED|HR_SYNC|']);
});

test('Zerar autenticador: desliga o 2FA e registra quem zerou', async () => {
  db(
    `update "User" set "twoFactorEnabled" = true, "twoFactorSecret" = 'teste', "twoFactorBackupCodes" = 'teste' where id = ${fx.activeId}`,
  );

  const denied = await trpcAs(fx.userCookie, 'mutation', 'admin.user.resetTwoFactor', { userId: fx.activeId });

  assert.equal(denied.status, 401, denied.text);

  const res = await trpcAs(fx.adminCookie, 'mutation', 'admin.user.resetTwoFactor', { userId: fx.activeId });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(db(`select "twoFactorEnabled" from "User" where id = ${fx.activeId}`), 'f');
  assert.deepEqual(eventsOf(fx.activeId), [`TOTP_RESET|ADMIN|${fx.adminId}`]);
});
