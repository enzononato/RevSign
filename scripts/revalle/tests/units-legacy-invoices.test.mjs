// v.26, Task 7: "Levar as notas antigas para a unidade de quem enviou" (Admin → Unidades e times).
//   - quem não é admin: 403; sem sessão: 401 (prévia e mover);
//   - a nota enviada pelo espaço pessoal de quem está num time de unidade entra na prévia; mover leva para o primeiro
//     time de unidade da pessoa, tira da pasta (folderId nulo) e grava o evento REVALLE_INVOICE_MOVED_TO_UNIT (times e
//     admin, sem e-mail); o Financeiro com escopo nessa unidade passa a ver a nota;
//   - a nota de quem não está em nenhuma unidade fica e entra em "ficam";
//   - o documento comum (não é nota) no espaço pessoal não é tocado;
//   - duas chamadas ao mesmo tempo (dois cliques, duas abas): uma trava no banco deixa só uma rodar (a outra volta com
//     `busy`, ou move 0 se chegou depois); juntas levam exatamente o que a prévia contou, e cada envelope tem um evento só;
//   - rodar de novo: move 0.
//
// A prévia e o botão valem para o banco inteiro: outras suítes também deixam notas no espaço pessoal. Por isso os números
// globais são conferidos com "pelo menos", e o resto pelas notas desta suíte.
// ATENÇÃO: esta suíte leva TODA nota antiga do banco do hml (de qualquer suíte) para a unidade de quem enviou. Nenhuma
// suíte pode reaproveitar uma nota do espaço pessoal entre execuções: crie a nota a cada execução.
//
// Montagem (como `units-finance-scope`): o admin cria a organização e o time pelas rotas do upstream; a marca de unidade
// (`RevalleUnit`), a entrada da conta na organização e o escopo do Financeiro são gravados por SQL. As notas antigas
// saem pela API com um token do espaço pessoal de cada conta (como "Apenas assinar"), vão por SQL ao time da unidade só
// para o admin marcar como nota fiscal (marcar fora de um time de unidade é recusado desde a v.26) e voltam por SQL ao
// espaço pessoal, como uma nota de antes da v.26.
//
// Sessões: REVSIGN_USER_* (usuário comum) e REVSIGN_ADMIN_* (admin). As contas das notas nascem pelo cadastro.

import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import './account-autologin.mjs';
import {
  assertNoPaidGeminiCalls,
  createConfirmedAccount,
  createEnvelope,
  db,
  disableLegacyUnitScope,
  distribute,
  ensureInvoiceAccounts,
  retryCreateOnStaleSocket,
  signIn,
  trpcAs,
} from './helpers.mjs';

disableLegacyUnitScope();

assertNoPaidGeminiCalls();

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = `Antigas-${RUN}-Senha1`;
const STAY_PEOPLE_LIMIT = 20;

const data = (res) => res.body?.result?.data?.json;

let userCookie;
let adminCookie;
let adminId;
let unit;
let mover;
let stayer;
let finance;
const docs = {};

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia' }).format(new Date());

const legacy = (cookie, kind, name) => trpcAs(cookie, kind, `revalle.units.legacyInvoices.${name}`, undefined);

const preview = async () => {
  const res = await legacy(adminCookie, 'query', 'preview');

  assert.equal(res.status, 200, res.text);

  return data(res);
};

const move = async () => {
  const res = await legacy(adminCookie, 'mutation', 'move');

  assert.equal(res.status, 200, res.text);

  return data(res);
};

const createUnit = async () => {
  const name = `Unidade Antigas ${RUN}`;
  const created = await trpcAs(adminCookie, 'mutation', 'organisation.create', { name });

  assert.equal(created.status, 200, created.text);

  const organisationId = db(`select id from "Organisation" where name = '${name}' order by "createdAt" desc limit 1`);
  const teamUrl = `antigas-${RUN}`;
  const team = await trpcAs(adminCookie, 'mutation', 'team.create', {
    organisationId,
    teamName: 'Time Antigas',
    teamUrl,
    inheritMembers: true,
  });

  assert.equal(team.status, 200, team.text);

  db(`insert into "RevalleUnit" ("organisationId", "hrUnitName") values ('${organisationId}', 'TESTE ANTIGAS ${RUN}')`);

  return { organisationId, teamId: Number(db(`select id from "Team" where url = '${teamUrl}'`)) };
};

// Membro comum da organização (grupo interno MEMBER): o time criado com `inheritMembers` herda o grupo.
const joinOrganisation = (organisationId, account) => {
  const memberId = `rsant_${account.id}_${RUN}`;

  db(
    `insert into "OrganisationMember" (id, "userId", "organisationId", "updatedAt") values ('${memberId}', ${account.id}, '${organisationId}', now())`,
  );
  db(
    `insert into "OrganisationGroupMember" (id, "groupId", "organisationMemberId")
       select 'rsantg_${account.id}_${RUN}', g.id, '${memberId}' from "OrganisationGroup" g
       where g."organisationId" = '${organisationId}' and g.type = 'INTERNAL_ORGANISATION' and g."organisationRole" = 'MEMBER'`,
  );
};

const personalTeamOf = (userId) =>
  Number(
    db(
      `select t.id from "Team" t join "Organisation" o on o.id = t."organisationId" where o.type = 'PERSONAL' and o."ownerUserId" = ${userId} order by t.id limit 1`,
    ),
  );

// Token do espaço pessoal (como `units-visibility`): no RevSign, criar token exige conta ADMIN; só para esta chamada.
const personalTokenFor = async (account) => {
  db(`update "User" set roles = array['USER','ADMIN']::"Role"[] where id = ${account.id}`);

  try {
    const token = await trpcAs(account.cookie, 'mutation', 'apiToken.create', {
      teamId: account.personalTeamId,
      tokenName: `antigas-${RUN}`,
      expirationDate: null,
    });

    assert.equal(token.status, 200, token.text);

    return data(token).token;
  } finally {
    db(`update "User" set roles = array['USER']::"Role"[] where id = ${account.id}`);
  }
};

// Documento enviado pelo espaço pessoal ("Apenas assinar"). `invoice`: marcado como nota fiscal pelo admin num time de
// unidade e devolvido ao pessoal por SQL. `folder`: dentro de uma pasta do time pessoal.
const sendFromPersonal = async (account, label, { invoice = true, folder = false } = {}) => {
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({
      recipients: [{ email: `antigas-${label}-dest-${RUN}@revalle.com.br` }],
      title: `[TESTE${invoice ? ' NF' : ''}] antigas ${label} ${RUN}`,
      apiToken: account.token,
    }),
  );

  assert.equal(created.status, 200, created.text);
  await distribute(created.id, { apiToken: account.token });

  if (invoice) {
    db(`update "Envelope" set "teamId" = ${unit.teamId} where id = '${created.id}'`);

    const marked = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: created.id });

    assert.equal(marked.status, 200, marked.text);
    db(`update "Envelope" set "teamId" = ${account.personalTeamId} where id = '${created.id}'`);
  }

  if (folder) {
    const folderId = `rsantf_${label}_${RUN}`;

    db(
      `insert into "Folder" (id, name, "userId", "teamId", type) values ('${folderId}', 'Pasta antigas', ${account.id}, ${account.personalTeamId}, 'DOCUMENT')`,
    );
    db(`update "Envelope" set "folderId" = '${folderId}' where id = '${created.id}'`);
  }

  return created.id;
};

const envelopeRow = (id) => {
  const [teamId, folderId] = db(`select "teamId" || '|' || coalesce("folderId", '') from "Envelope" where id = '${id}'`)
    .split('|')
    .map((value) => value.trim());

  return { teamId: Number(teamId), folderId: folderId || null };
};

const movedEvents = (id) =>
  JSON.parse(
    db(
      `select coalesce(json_agg(json_build_object('data', data, 'userId', "userId") order by "createdAt"), '[]') from "DocumentAuditLog" where "envelopeId" = '${id}' and type = 'REVALLE_INVOICE_MOVED_TO_UNIT'`,
    ),
  );

const financeIds = async () => {
  const res = await trpcAs(finance.cookie, 'query', 'revalle.invoice.find', { from: today(), perPage: 100 });

  assert.equal(res.status, 200, res.text);

  return new Set(data(res).data.map((row) => row.id));
};

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
  adminId = Number(db(`select id from "User" where email = '${admin.email}'`));
  await ensureInvoiceAccounts(adminCookie);

  unit = await createUnit();

  mover = await createConfirmedAccount({
    email: `antigas-unidade-${RUN}@revalle.com.br`,
    name: 'Antigas Unidade',
    password: PASSWORD,
  });
  stayer = await createConfirmedAccount({
    email: `antigas-sem-${RUN}@revalle.com.br`,
    name: 'Antigas Sem Unidade',
    password: PASSWORD,
  });
  finance = await createConfirmedAccount({
    email: `antigas-fin-${RUN}@revalle.com.br`,
    name: 'Antigas Financeiro',
    password: PASSWORD,
  });

  for (const account of [mover, stayer]) {
    account.personalTeamId = personalTeamOf(account.id);
    account.token = await personalTokenFor(account);
  }

  const financeMember = await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', {
    userId: finance.id,
    member: true,
  });

  assert.equal(financeMember.status, 200, financeMember.text);
  db(`insert into "RevalleUnitScope" ("userId", "organisationId") values (${finance.id}, '${unit.organisationId}')`);

  docs.moving = await sendFromPersonal(mover, 'leva', { folder: true });
  docs.plain = await sendFromPersonal(mover, 'comum', { invoice: false });
  docs.staying = await sendFromPersonal(stayer, 'fica');

  // Só depois das notas: a conta entra no time da unidade (o destino).
  joinOrganisation(unit.organisationId, mover);
});

sessionTest('quem não é admin: 403; sem sessão: 401', async () => {
  assert.equal((await legacy(userCookie, 'query', 'preview')).status, 403);
  assert.equal((await legacy(userCookie, 'mutation', 'move')).status, 403);
  assert.equal((await legacy('', 'query', 'preview')).status, 401);
  assert.equal((await legacy('', 'mutation', 'move')).status, 401);

  assert.equal(envelopeRow(docs.moving).teamId, mover.personalTeamId, 'a nota saiu do pessoal sem o admin');
});

sessionTest('prévia, mover, o Financeiro passa a ver e rodar de novo move 0', async () => {
  assert.ok(!(await financeIds()).has(docs.moving), 'o Financeiro viu a nota ainda no espaço pessoal');

  const before = await preview();

  assert.ok(before.moveCount >= 1, `prévia sem nota a levar: ${JSON.stringify(before.moveCount)}`);
  assert.ok(before.movePeopleCount >= 1);
  assert.ok(before.stayCount >= 1, 'a nota de quem não está em unidade não entrou em "ficam"');
  assert.ok(before.stayPeopleCount >= 1);
  assert.equal(typeof before.conflictCount, 'number');
  assert.ok(before.stayPeople.length <= STAY_PEOPLE_LIMIT);
  assert.ok(
    !before.stayPeople.some((person) => person.userId === mover.id),
    'quem está em unidade apareceu em "ficam"',
  );

  if (before.stayPeopleCount <= STAY_PEOPLE_LIMIT) {
    const listed = before.stayPeople.find((person) => person.userId === stayer.id);

    assert.ok(listed, 'quem não está em unidade não apareceu na lista');
    assert.equal(listed.count, 1);
    assert.equal(listed.email, stayer.email);
  }

  // A prévia não grava nada.
  assert.equal(envelopeRow(docs.moving).teamId, mover.personalTeamId);

  // Dois cliques ao mesmo tempo: só um roda (a trava no banco); juntos levam exatamente o que a prévia contou.
  const results = await Promise.all([move(), move()]);
  const ran = results.filter((result) => !result.busy);

  assert.ok(ran.length >= 1, JSON.stringify(results));
  assert.equal(
    results.reduce((total, result) => total + result.moved, 0),
    before.moveCount,
    JSON.stringify(results),
  );
  assert.ok(
    results.every((result) => result.failed === 0),
    JSON.stringify(results),
  );
  assert.ok(
    ran.some((result) => result.moved >= 1 && result.stayed >= 1),
    JSON.stringify(results),
  );

  for (const result of results.filter((item) => item.busy)) {
    assert.deepEqual(result, { moved: 0, failed: 0, stayed: 0, busy: true });
  }

  // Nenhum envelope do banco ganhou dois eventos.
  assert.equal(
    db(
      `select count(*) from (select "envelopeId" from "DocumentAuditLog" where type = 'REVALLE_INVOICE_MOVED_TO_UNIT' group by "envelopeId" having count(*) > 1) d`,
    ),
    '0',
  );

  assert.deepEqual(envelopeRow(docs.moving), { teamId: unit.teamId, folderId: null });

  const events = movedEvents(docs.moving);

  assert.equal(events.length, 1, JSON.stringify(events));
  assert.equal(events[0].userId, adminId);
  assert.equal(events[0].data.fromTeamId, mover.personalTeamId);
  assert.equal(events[0].data.toTeamId, unit.teamId);
  assert.equal(events[0].data.toTeamName, 'Time Antigas');
  assert.equal(events[0].data.movedByUserId, adminId);
  assert.ok(!JSON.stringify(events[0].data).includes('@'), 'o evento trouxe e-mail');

  // A de quem não está em unidade fica; o documento comum não é tocado.
  assert.equal(envelopeRow(docs.staying).teamId, stayer.personalTeamId);
  assert.equal(movedEvents(docs.staying).length, 0);
  assert.equal(envelopeRow(docs.plain).teamId, mover.personalTeamId);
  assert.equal(movedEvents(docs.plain).length, 0);

  assert.ok((await financeIds()).has(docs.moving), 'o Financeiro da unidade não viu a nota levada');

  const again = await move();

  assert.equal(again.moved, 0, JSON.stringify(again));
  assert.equal(again.failed, 0, JSON.stringify(again));
  assert.equal(again.busy, false, JSON.stringify(again));
  assert.equal((await preview()).moveCount, 0);
  assert.equal(movedEvents(docs.moving).length, 1, 'rodar de novo gravou outro evento');
});
