// v.26, Task 3: o Financeiro e a Contabilidade só enxergam e só agem nas notas das unidades do seu escopo
// (`RevalleUnitScope`). A unidade da nota é a organização do time pelo qual ela saiu.
//   - quem cobre as unidades A e B vê as notas de A e B na lista, na fila e no contador do menu, e não vê a de C;
//   - aprovar, trocar conta, validar, corrigir o centro, os cartões e a página da nota de C dão 404; a de A aprova;
//   - a planilha segue a lista;
//   - do Financeiro sem nenhuma unidade: não vê nota de unidade nenhuma, o contador é zero e aprovar dá 404;
//   - a nota antiga do espaço pessoal: só o admin e quem enviou (o Financeiro com escopo não vê).
//
// Montagem: o admin cria as três organizações e os times pelas rotas do upstream (`organisation.create`, `team.create`).
// Só a marca de unidade (`RevalleUnit`), as linhas de escopo e o time do envelope são gravados por SQL, para preparar o
// cenário (as rotas do painel de unidades são de outra tarefa). As notas saem pela API (REVSIGN_USER, documento comum),
// vão para o time da unidade e só então o admin as marca como nota fiscal: desde a Task 2, marcar como NF um envio de
// fora de um time de unidade é recusado. A nota "antiga do espaço pessoal" é marcada num time de unidade e devolvida ao
// time pessoal de quem enviou por SQL, para simular uma nota de antes da v.26.
//
// Sessões: REVSIGN_USER_* (remetente) e REVSIGN_ADMIN_* (admin). As duas contas do perfil nascem pelo cadastro.

import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import './account-autologin.mjs';
import {
  assertNoPaidGeminiCalls,
  BASE_URL,
  createConfirmedAccount,
  createEnvelope,
  db,
  disableLegacyUnitScope,
  distribute,
  ensureInvoiceAccounts,
  fetchIdempotent,
  retryCreateOnStaleSocket,
  signIn,
  trpcAs,
} from './helpers.mjs';

disableLegacyUnitScope();

assertNoPaidGeminiCalls();

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = `Escopo-${RUN}-Senha1`;
const REASON = 'Conta de serviço, não de material.';

const data = (res) => res.body?.result?.data?.json;

let userCookie;
let adminCookie;
let scoped;
let unscoped;
const units = {};
const invoices = {};

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia' }).format(new Date());

const createUnit = async (label) => {
  const name = `Unidade ${label} ${RUN}`;
  const created = await trpcAs(adminCookie, 'mutation', 'organisation.create', { name });

  assert.equal(created.status, 200, created.text);

  const organisationId = db(`select id from "Organisation" where name = '${name}' order by "createdAt" desc limit 1`);
  const teamUrl = `escopo-${label.toLowerCase()}-${RUN}`;
  const team = await trpcAs(adminCookie, 'mutation', 'team.create', {
    organisationId,
    teamName: `Time ${label}`,
    teamUrl,
    inheritMembers: true,
  });

  assert.equal(team.status, 200, team.text);

  db(
    `insert into "RevalleUnit" ("organisationId", "hrUnitName") values ('${organisationId}', 'TESTE ${label} ${RUN}')`,
  );

  return { organisationId, teamId: Number(db(`select id from "Team" where url = '${teamUrl}'`)) };
};

// Time pessoal de quem envia (REVSIGN_USER): o primeiro time da organização pessoal dele.
const personalTeamOf = (email) =>
  Number(
    db(
      `select t.id from "Team" t join "Organisation" o on o.id = t."organisationId" join "User" u on u.id = o."ownerUserId" where o.type = 'PERSONAL' and u.email = '${email}' order by t.id limit 1`,
    ),
  );

// NF enviada (aguarda o Financeiro): documento comum enviado, movido para o time da unidade `teamId` e marcado como NF
// pelo admin (marcar só vale num time de unidade). `legacyPersonal`: depois de marcada, volta ao time pessoal.
const sendInvoice = async (label, teamId, { legacyPersonal = false } = {}) => {
  const email = `escopo-${label}-${RUN}@revalle.com.br`;
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({ recipients: [{ email }], title: `[TESTE NF] escopo ${label} ${RUN}` }),
  );

  assert.equal(created.status, 200, created.text);
  await distribute(created.id);

  db(`update "Envelope" set "teamId" = ${teamId} where id = '${created.id}'`);

  const marked = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: created.id });

  assert.equal(marked.status, 200, marked.text);

  if (legacyPersonal) {
    db(`update "Envelope" set "teamId" = ${personalTeamOf(user.email)} where id = '${created.id}'`);
  }

  return created.id;
};

const listIds = async (cookie, filters = {}) => {
  const res = await trpcAs(cookie, 'query', 'revalle.invoice.find', { from: today(), perPage: 100, ...filters });

  assert.equal(res.status, 200, res.text);

  return new Set(data(res).data.map((row) => row.id));
};

const pendingCounts = async (cookie) => data(await trpcAs(cookie, 'query', 'revalle.invoice.pendingCounts'));

const pageStatus = (cookie, envelopeId) =>
  fetchIdempotent(`${BASE_URL}/notas-fiscais/${envelopeId}`, { headers: { Cookie: cookie } }, (res) => res.status);

const sessionTest = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie || !adminCookie) {
      t.skip('credenciais de sessão não informadas');

      return;
    }

    await fn();
  });

before(async () => {
  if (!user.email || !user.password || !admin.email || !admin.password) {
    return;
  }

  userCookie = await signIn(user.email, user.password);
  adminCookie = await signIn(admin.email, admin.password);
  await ensureInvoiceAccounts(adminCookie);

  for (const label of ['A', 'B', 'C']) {
    units[label] = await createUnit(label);
  }

  scoped = await createConfirmedAccount({
    email: `escopo-fin-${RUN}@revalle.com.br`,
    name: 'Escopo AB',
    password: PASSWORD,
  });
  unscoped = await createConfirmedAccount({
    email: `escopo-sem-${RUN}@revalle.com.br`,
    name: 'Escopo Nenhum',
    password: PASSWORD,
  });

  for (const account of [scoped, unscoped]) {
    const finance = await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', {
      userId: account.id,
      member: true,
    });
    const accounting = await trpcAs(adminCookie, 'mutation', 'revalle.accounting.adminSetMember', {
      userId: account.id,
      isMember: true,
    });

    assert.equal(finance.status, 200, finance.text);
    assert.equal(accounting.status, 200, accounting.text);
  }

  db(
    `insert into "RevalleUnitScope" ("userId", "organisationId") values (${scoped.id}, '${units.A.organisationId}'), (${scoped.id}, '${units.B.organisationId}')`,
  );

  invoices.A = await sendInvoice('a', units.A.teamId);
  invoices.B = await sendInvoice('b', units.B.teamId);
  invoices.C = await sendInvoice('c', units.C.teamId);
  invoices.personal = await sendInvoice('pessoal', units.C.teamId, { legacyPersonal: true });
});

sessionTest('lista, fila e contador: só as notas das unidades A e B', async () => {
  const all = await listIds(scoped.cookie);

  assert.ok(all.has(invoices.A) && all.has(invoices.B), 'faltou nota de A ou B');
  assert.ok(!all.has(invoices.C), 'a nota da unidade C apareceu');
  assert.ok(!all.has(invoices.personal), 'a nota do espaço pessoal apareceu');

  const queue = await listIds(scoped.cookie, { finance: 'pendentes' });

  assert.deepEqual([...queue].sort(), [invoices.A, invoices.B].sort());

  // As unidades são novas: só as duas notas delas esperam.
  assert.deepEqual(await pendingCounts(scoped.cookie), { finance: 2, accounting: 2 });
});

sessionTest('nota de outra unidade: ações, cartões e página dão 404; a da unidade aprova', async () => {
  const id = invoices.C;
  const calls = [
    trpcAs(scoped.cookie, 'mutation', 'revalle.finance.approve', { envelopeId: id, code: '2.1.03' }),
    trpcAs(scoped.cookie, 'mutation', 'revalle.finance.changeAccount', {
      envelopeId: id,
      code: '3.1.01',
      reason: REASON,
    }),
    trpcAs(scoped.cookie, 'mutation', 'revalle.accounting.validate', { envelopeId: id }),
    trpcAs(scoped.cookie, 'mutation', 'revalle.accounting.changeCostCenter', {
      envelopeId: id,
      code: '102',
      reason: REASON,
    }),
    trpcAs(scoped.cookie, 'query', 'revalle.finance.get', { envelopeId: id }),
    trpcAs(scoped.cookie, 'query', 'revalle.accounting.get', { envelopeId: id }),
  ];

  for (const res of await Promise.all(calls)) {
    assert.equal(res.status, 404, res.text);
  }

  assert.equal(await pageStatus(scoped.cookie, id), 404);
  assert.equal(
    db(`select "financeStatus" from "RevalleInvoiceClassification" where "envelopeId" = '${id}'`),
    'PENDING_APPROVAL',
  );

  assert.equal(await pageStatus(scoped.cookie, invoices.A), 200);

  const approved = await trpcAs(scoped.cookie, 'mutation', 'revalle.finance.approve', {
    envelopeId: invoices.A,
    code: '2.1.03',
  });

  assert.equal(approved.status, 200, approved.text);
});

sessionTest('planilha: as notas de A e B, sem a de C', async () => {
  const text = await fetchIdempotent(
    `${BASE_URL}/notas-fiscais/csv?de=${today()}`,
    { headers: { Cookie: scoped.cookie } },
    (res) => res.text(),
  );

  assert.ok(text.includes(invoices.A) && text.includes(invoices.B), 'faltou nota de A ou B');
  assert.ok(!text.includes(invoices.C), 'a nota da unidade C saiu na planilha');
});

sessionTest('sem nenhuma unidade: nada, contador zero e 404 ao aprovar', async () => {
  const all = await listIds(unscoped.cookie);

  for (const id of Object.values(invoices)) {
    assert.ok(!all.has(id), `nota ${id} apareceu para quem não tem unidade`);
  }

  assert.deepEqual(await pendingCounts(unscoped.cookie), { finance: 0, accounting: 0 });

  const res = await trpcAs(unscoped.cookie, 'mutation', 'revalle.finance.approve', {
    envelopeId: invoices.B,
    code: '2.1.03',
  });

  assert.equal(res.status, 404, res.text);
});

sessionTest('nota antiga do espaço pessoal: o admin e quem enviou abrem; o Financeiro com escopo, não', async () => {
  assert.equal(await pageStatus(userCookie, invoices.personal), 200);
  assert.equal(await pageStatus(adminCookie, invoices.personal), 200);
  assert.equal(await pageStatus(scoped.cookie, invoices.personal), 404);
  assert.equal(await pageStatus(adminCookie, invoices.C), 200);
});
