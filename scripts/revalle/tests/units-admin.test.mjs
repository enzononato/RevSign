// v.26, Task 1: Admin → "Unidades e times" (`revalle.units.*`). Confere:
//   - usuário comum recebe 403 (lista e "Criar as 7 unidades"); nada é criado;
//   - "Criar as 7 unidades" é idempotente pela chave do RH (`RevalleUnit.hrUnitName`): rodar de novo não cria nada;
//   - os times de cada unidade vêm dos setores do RH com alguém ativo (base de teste: `revalle/colaboradores/dev-seed.sql`;
//     "afastado" conta como ativo; o casamento "Senhor do Bonfim" → "Bonfim" e o corte dos desligados estão no vitest
//     `units/names.test.ts`) e rodar de novo não repete time;
//   - salvar os times mantém o papel de gerente e de administrador do time que continua marcado;
//   - criar, renomear e remover um time vazio;
//   - uma pessoa entra na unidade como MEMBRO da organização e MEMBRO de dois times; trocar os times e tirar da unidade;
//   - "Ver só o que enviou ou recebeu para assinar" e as unidades do Financeiro liga e desliga, e uma organização que não
//     é unidade é recusada.
//
// Sessões: REVSIGN_ADMIN_* (rsadmin, ADMIN) e REVSIGN_USER_* (usuário comum). A pessoa adicionada é uma conta de teste
// criada direto no banco a cada execução. As 7 unidades ficam no banco (outros testes da v.26 usam). Ver
// revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { ensureTestAccount } from './account-helpers.mjs';
import { db, signIn, trpcAs } from './helpers.mjs';

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const UNITS = ['Juazeiro', 'Bonfim', 'Petrolina', 'Ribeira do Pombal', 'Paulo Afonso', 'Alagoinhas', 'Serrinha'];
const UNITS_SQL = UNITS.map((name) => `'${name.replaceAll("'", "''")}'`).join(', ');

let userCookie;
let adminCookie;
let person;

const data = (res) => res.body?.result?.data?.json;
const units = (cookie, kind, name, input) => trpcAs(cookie, kind, `revalle.units.${name}`, input);

const ok = async (promise) => {
  const res = await promise;

  assert.equal(res.status, 200, res.text);

  return data(res);
};

const unitCount = () => Number(db(`select count(*) from "RevalleUnit" where "hrUnitName" in (${UNITS_SQL})`));
const orgIdOf = (hrUnitName) => db(`select "organisationId" from "RevalleUnit" where "hrUnitName" = '${hrUnitName}'`);
const getUnit = (organisationId) => ok(units(adminCookie, 'query', 'get', { organisationId }));

before(async () => {
  assert.ok(user.email && user.password, 'defina REVSIGN_USER_EMAIL e REVSIGN_USER_PASSWORD');
  assert.ok(admin.email && admin.password, 'defina REVSIGN_ADMIN_EMAIL e REVSIGN_ADMIN_PASSWORD');

  [userCookie, adminCookie] = await Promise.all([
    signIn(user.email, user.password),
    signIn(admin.email, admin.password),
  ]);

  const email = ensureTestAccount(`t1-unidades-${RUN}@revalle.com.br`, 'Pessoa Unidades T1');

  person = { email, id: Number(db(`select id from "User" where email = '${email}'`)) };
});

after(() => {
  if (person?.id) {
    db(`delete from "RevalleUnitScope" where "userId" = ${person.id}`);
    db(`delete from "RevalleUserVisibility" where "userId" = ${person.id}`);
    db(`delete from "RevalleFinanceMember" where "userId" = ${person.id}`);
  }
});

test('usuário comum recebe 403 e nada é criado', async () => {
  const before = unitCount();

  const list = await units(userCookie, 'query', 'list', undefined);
  assert.equal(list.status, 403, list.text);

  const create = await units(userCookie, 'mutation', 'createDefaults', undefined);
  assert.equal(create.status, 403, create.text);

  const scope = await units(userCookie, 'mutation', 'setOwnOnly', { userId: person.id, ownOnly: true });
  assert.equal(scope.status, 403, scope.text);

  assert.equal(unitCount(), before);
  assert.equal(db(`select count(*) from "RevalleUserVisibility" where "userId" = ${person.id}`), '0');
});

test('"Criar as 7 unidades" é idempotente e os times vêm dos setores do RH', async () => {
  const first = await ok(units(adminCookie, 'mutation', 'createDefaults', undefined));

  assert.equal(first.hrAvailable, true, 'a base do RH de teste precisa responder');
  assert.equal(first.created.length + first.existing.length, 7);
  assert.equal(unitCount(), 7);

  const teamsBefore = db(
    `select count(*) from "Team" t join "RevalleUnit" u on u."organisationId" = t."organisationId"`,
  );

  const second = await ok(units(adminCookie, 'mutation', 'createDefaults', undefined));

  assert.deepEqual(second.created, []);
  assert.equal(second.existing.length, 7);
  assert.equal(second.teamsCreated, 0, 'rodar de novo não repete time');
  assert.equal(unitCount(), 7);
  assert.equal(
    db(`select count(*) from "Team" t join "RevalleUnit" u on u."organisationId" = t."organisationId"`),
    teamsBefore,
  );

  const list = await ok(units(adminCookie, 'query', 'list', undefined));
  assert.deepEqual(list.missingDefaultUnits, []);
  assert.deepEqual(
    list.units.filter((unit) => UNITS.includes(unit.hrUnitName)).map((unit) => unit.hrUnitName),
    UNITS,
    'as 7 na ordem da tela',
  );

  // Base de teste: Juazeiro tem Administrativo e Recursos Humanos; Paulo Afonso tem Entrega (colaborador afastado).
  const juazeiro = await getUnit(orgIdOf('Juazeiro'));
  const names = juazeiro.teams.map((team) => team.name);
  assert.ok(names.includes('Administrativo'), names.join(', '));
  assert.ok(names.includes('Recursos Humanos'), names.join(', '));
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length, 'sem time repetido');

  const pauloAfonso = await getUnit(orgIdOf('Paulo Afonso'));
  assert.ok(
    pauloAfonso.teams.some((team) => team.name === 'Entrega'),
    pauloAfonso.teams.map((team) => team.name).join(', '),
  );

  // Criar de novo pelo botão da unidade não cria nada.
  const again = await ok(units(adminCookie, 'mutation', 'createTeamsFromHr', { organisationId: orgIdOf('Juazeiro') }));
  assert.equal(again.hrAvailable, true);
  assert.deepEqual(again.created, []);

  // Os times da unidade não herdam os membros da organização (cada pessoa só entra nos times escolhidos).
  assert.equal(
    db(
      `select count(*) from "TeamGroup" tg join "OrganisationGroup" og on og.id = tg."organisationGroupId"
       where og."organisationId" = '${orgIdOf('Juazeiro')}' and og.type = 'INTERNAL_ORGANISATION'
       and og."organisationRole" = 'MEMBER'`,
    ),
    '0',
  );
});

test('criar, renomear e remover um time vazio; nome repetido é recusado', async () => {
  const organisationId = orgIdOf('Serrinha');

  const { teamId } = await ok(
    units(adminCookie, 'mutation', 'createTeam', { organisationId, name: `Teste T1 ${RUN}` }),
  );

  const duplicate = await units(adminCookie, 'mutation', 'createTeam', { organisationId, name: `teste t1 ${RUN}` });
  assert.equal(duplicate.status, 409, duplicate.text);

  await ok(units(adminCookie, 'mutation', 'renameTeam', { teamId, name: `Teste T1 ${RUN} B` }));
  assert.equal(db(`select name from "Team" where id = ${teamId}`), `Teste T1 ${RUN} B`);

  await ok(units(adminCookie, 'mutation', 'deleteTeam', { teamId }));
  assert.equal(db(`select count(*) from "Team" where id = ${teamId}`), '0');
});

test('pessoa entra como membro da unidade e de dois times; troca os times e sai', async () => {
  const organisationId = orgIdOf('Juazeiro');
  const unit = await getUnit(organisationId);
  const [teamA, teamB] = ['Administrativo', 'Recursos Humanos'].map((name) =>
    unit.teams.find((team) => team.name === name),
  );

  const search = await ok(units(adminCookie, 'query', 'searchUsers', { organisationId, query: `t1-unidades-${RUN}` }));
  assert.deepEqual(
    search.users.map((found) => found.id),
    [person.id],
  );
  assert.equal(search.users[0].isMember, false);

  await ok(
    units(adminCookie, 'mutation', 'addMember', {
      organisationId,
      userId: person.id,
      teams: [
        { teamId: teamA.id, role: 'MEMBER' },
        { teamId: teamB.id, role: 'MEMBER' },
      ],
    }),
  );

  const member = (await getUnit(organisationId)).members.find((row) => row.userId === person.id);
  assert.ok(member, 'a pessoa aparece na unidade');
  assert.equal(member.organisationRole, 'MEMBER');
  assert.deepEqual(
    member.teams.map((choice) => [choice.teamId, choice.role]).sort(),
    [
      [teamA.id, 'MEMBER'],
      [teamB.id, 'MEMBER'],
    ].sort(),
  );

  // Pelo caminho do upstream (grupo → time), a pessoa alcança exatamente os dois times, como MEMBRO.
  const reach = db(
    `select string_agg(distinct tg."teamId" || ':' || tg."teamRole", ',')
     from "OrganisationMember" om
     join "OrganisationGroupMember" ogm on ogm."organisationMemberId" = om.id
     join "TeamGroup" tg on tg."organisationGroupId" = ogm."groupId"
     where om."userId" = ${person.id} and om."organisationId" = '${organisationId}'`,
  );
  assert.deepEqual(reach.split(',').sort(), [`${teamA.id}:MEMBER`, `${teamB.id}:MEMBER`].sort());

  // Adicionar de novo não duplica nada.
  await ok(
    units(adminCookie, 'mutation', 'addMember', {
      organisationId,
      userId: person.id,
      teams: [
        { teamId: teamA.id, role: 'MEMBER' },
        { teamId: teamB.id, role: 'MEMBER' },
      ],
    }),
  );
  assert.equal(
    db(
      `select count(*) from "OrganisationMember" where "userId" = ${person.id} and "organisationId" = '${organisationId}'`,
    ),
    '1',
  );

  // Só o time B, como gerente.
  await ok(
    units(adminCookie, 'mutation', 'setMemberTeams', {
      organisationId,
      userId: person.id,
      teams: [{ teamId: teamB.id, role: 'MANAGER' }],
    }),
  );
  const changed = (await getUnit(organisationId)).members.find((row) => row.userId === person.id);
  assert.deepEqual(changed.teams, [{ teamId: teamB.id, role: 'MANAGER' }]);

  const teamsOf = async () =>
    (await getUnit(organisationId)).members
      .find((row) => row.userId === person.id)
      .teams.map((choice) => [choice.teamId, choice.role])
      .sort();
  const groupOf = (teamId, role) =>
    db(
      `select tg."organisationGroupId" from "TeamGroup" tg join "OrganisationGroup" og on og.id = tg."organisationGroupId"
       where tg."teamId" = ${teamId} and tg."teamRole" = '${role}' and og.type = 'INTERNAL_TEAM'`,
    );
  const memberId = db(
    `select id from "OrganisationMember" where "userId" = ${person.id} and "organisationId" = '${organisationId}'`,
  );

  // Salvar de novo com o time B marcado, sem papel no pedido: continua gerente.
  await ok(
    units(adminCookie, 'mutation', 'setMemberTeams', {
      organisationId,
      userId: person.id,
      teams: [{ teamId: teamB.id }],
    }),
  );
  assert.deepEqual(await teamsOf(), [[teamB.id, 'MANAGER']]);

  // Administrador do time A dado fora do painel (tela do upstream): salvar com A marcado não rebaixa nem tira.
  db(
    `insert into "OrganisationGroupMember" (id, "groupId", "organisationMemberId")
     values ('t1_gm_${RUN}', '${groupOf(teamA.id, 'ADMIN')}', '${memberId}')`,
  );
  assert.deepEqual(
    await teamsOf(),
    [
      [teamA.id, 'ADMIN'],
      [teamB.id, 'MANAGER'],
    ].sort(),
  );

  await ok(
    units(adminCookie, 'mutation', 'setMemberTeams', {
      organisationId,
      userId: person.id,
      teams: [
        { teamId: teamA.id, role: 'MEMBER' },
        { teamId: teamB.id, role: 'MANAGER' },
      ],
    }),
  );
  assert.deepEqual(
    await teamsOf(),
    [
      [teamA.id, 'ADMIN'],
      [teamB.id, 'MANAGER'],
    ].sort(),
  );
  assert.equal(
    db(
      `select count(*) from "OrganisationGroupMember" where "organisationMemberId" = '${memberId}'
       and "groupId" = '${groupOf(teamA.id, 'MEMBER')}'`,
    ),
    '0',
  );

  // Desmarcar A tira a pessoa do time, mesmo sendo administradora dele.
  await ok(
    units(adminCookie, 'mutation', 'setMemberTeams', {
      organisationId,
      userId: person.id,
      teams: [{ teamId: teamB.id, role: 'MANAGER' }],
    }),
  );
  assert.deepEqual(await teamsOf(), [[teamB.id, 'MANAGER']]);

  // Time de outra unidade é recusado.
  const otherTeam = (await getUnit(orgIdOf('Petrolina'))).teams[0];
  if (otherTeam) {
    const refused = await units(adminCookie, 'mutation', 'setMemberTeams', {
      organisationId,
      userId: person.id,
      teams: [{ teamId: otherTeam.id, role: 'MEMBER' }],
    });
    assert.equal(refused.status, 400, refused.text);
  }

  // O dono da unidade não sai.
  const ownerId = Number(db(`select "ownerUserId" from "Organisation" where id = '${organisationId}'`));
  const ownerOut = await units(adminCookie, 'mutation', 'removeMember', { organisationId, userId: ownerId });
  assert.equal(ownerOut.status, 400, ownerOut.text);

  await ok(units(adminCookie, 'mutation', 'removeMember', { organisationId, userId: person.id }));
  assert.equal(
    db(
      `select count(*) from "OrganisationMember" where "userId" = ${person.id} and "organisationId" = '${organisationId}'`,
    ),
    '0',
  );
});

test('"ver só o seu" e as unidades do Financeiro ligam e desligam', async () => {
  await ok(units(adminCookie, 'mutation', 'setOwnOnly', { userId: person.id, ownOnly: true }));
  assert.equal(db(`select "ownOnly" from "RevalleUserVisibility" where "userId" = ${person.id}`), 't');

  await ok(units(adminCookie, 'mutation', 'setOwnOnly', { userId: person.id, ownOnly: false }));
  assert.equal(db(`select "ownOnly" from "RevalleUserVisibility" where "userId" = ${person.id}`), 'f');

  const setFinance = await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', {
    userId: person.id,
    member: true,
  });
  assert.equal(setFinance.status, 200, setFinance.text);

  const scope = [orgIdOf('Juazeiro'), orgIdOf('Petrolina')];

  await ok(units(adminCookie, 'mutation', 'setScope', { userId: person.id, organisationIds: scope }));
  assert.deepEqual(
    db(`select string_agg("organisationId", ',') from "RevalleUnitScope" where "userId" = ${person.id}`)
      .split(',')
      .sort(),
    [...scope].sort(),
  );

  const profiles = await ok(units(adminCookie, 'query', 'listProfiles', undefined));
  const row = profiles.users.find((profile) => profile.userId === person.id);
  assert.ok(row?.isFinanceMember);
  assert.deepEqual([...row.scopeOrganisationIds].sort(), [...scope].sort());

  // Trocar a lista inteira: fica só Juazeiro.
  await ok(units(adminCookie, 'mutation', 'setScope', { userId: person.id, organisationIds: [orgIdOf('Juazeiro')] }));
  assert.equal(db(`select count(*) from "RevalleUnitScope" where "userId" = ${person.id}`), '1');

  // Organização que não é unidade (a pessoal do admin) é recusada, e nada muda.
  const personalOrg = db(
    `select o.id from "Organisation" o where o.type = 'PERSONAL'
     and not exists (select 1 from "RevalleUnit" u where u."organisationId" = o.id) limit 1`,
  );
  if (personalOrg) {
    const refused = await units(adminCookie, 'mutation', 'setScope', {
      userId: person.id,
      organisationIds: [personalOrg],
    });
    assert.equal(refused.status, 400, refused.text);
    assert.equal(db(`select count(*) from "RevalleUnitScope" where "userId" = ${person.id}`), '1');
  }

  await ok(units(adminCookie, 'mutation', 'setScope', { userId: person.id, organisationIds: [] }));
  assert.equal(db(`select count(*) from "RevalleUnitScope" where "userId" = ${person.id}`), '0');
});
