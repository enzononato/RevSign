// v.26, Task 2: visibilidade "ver só o que enviou ou recebeu para assinar" e nota fiscal só do time da unidade.
//   - um membro vê os documentos do time e não os de outro time (API v2, lista da tela);
//   - com `ownOnly`, o documento do colega some da lista, dos contadores, da busca, da API v2 (lista e por id = 404), do
//     download pela API e do arquivo pela sessão; o documento em que a pessoa é destinatária continua; o colega sem a marca
//     segue vendo tudo; o admin com a marca não é limitado;
//   - nota fiscal (classificação YES) do espaço pessoal é recusada com a mensagem exata; "Apenas assinar" no pessoal
//     passa; marcar como NF depois do envio um documento do pessoal é recusado com a mesma mensagem; a nota do time da
//     unidade passa.
//
// Montagem: o admin cria as duas organizações e os times pelas rotas do upstream (`organisation.create`, `team.create`).
// A marca de unidade (`RevalleUnit`), a entrada das duas contas na organização A (membro, no grupo interno MEMBER, que o
// time herda) e a marca `ownOnly` são gravadas por SQL, só para preparar o cenário: as rotas do painel de unidades são de
// outra tarefa. Os tokens de API das contas comuns seguem o aceite da Fase 7 (promoção a ADMIN só na criação do token).
//
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN, espaço pessoal) e REVSIGN_ADMIN_* (admin). As duas contas do time
// nascem pelo cadastro. Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import './account-autologin.mjs';
import {
  api,
  assertNoPaidGeminiCalls,
  BASE_URL,
  chooseInvoice,
  createConfirmedAccount,
  createEnvelope,
  danfePdfFile,
  db,
  ensureInvoiceAccounts,
  fetchIdempotent,
  retryCreateOnStaleSocket,
  signIn,
  trpcAs,
} from './helpers.mjs';

assertNoPaidGeminiCalls();

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = `Visao-${RUN}-Senha1`;
const UNIT_MESSAGE = 'Nota fiscal deve ser enviada pelo time da sua unidade. Troque para o time no topo da tela.';

const data = (res) => res.body?.result?.data?.json;

let userCookie;
let adminCookie;
let adminId;
let member;
let colleague;
const units = {};
const docs = {};

const createUnit = async (label) => {
  const name = `Unidade Visao ${label} ${RUN}`;
  const created = await trpcAs(adminCookie, 'mutation', 'organisation.create', { name });

  assert.equal(created.status, 200, created.text);

  const organisationId = db(`select id from "Organisation" where name = '${name}' order by "createdAt" desc limit 1`);
  const teamUrl = `visao-${label.toLowerCase()}-${RUN}`;
  const team = await trpcAs(adminCookie, 'mutation', 'team.create', {
    organisationId,
    teamName: `Time Visao ${label}`,
    teamUrl,
    inheritMembers: true,
  });

  assert.equal(team.status, 200, team.text);

  db(
    `insert into "RevalleUnit" ("organisationId", "hrUnitName") values ('${organisationId}', 'TESTE VISAO ${label} ${RUN}')`,
  );

  return { organisationId, teamId: Number(db(`select id from "Team" where url = '${teamUrl}'`)) };
};

// Membro comum da organização (grupo interno MEMBER): o time criado com `inheritMembers` herda o grupo.
const joinOrganisation = (organisationId, account) => {
  const memberId = `rsvis_${account.id}_${RUN}`;

  db(
    `insert into "OrganisationMember" (id, "userId", "organisationId", "updatedAt") values ('${memberId}', ${account.id}, '${organisationId}', now())`,
  );
  db(
    `insert into "OrganisationGroupMember" (id, "groupId", "organisationMemberId")
       select 'rsvisg_${account.id}_${RUN}', g.id, '${memberId}' from "OrganisationGroup" g
       where g."organisationId" = '${organisationId}' and g.type = 'INTERNAL_ORGANISATION' and g."organisationRole" = 'MEMBER'`,
  );
};

// Só o ADMIN cria token de API: a conta comum é promovida só para esta chamada (o token continua valendo).
const tokenFor = async (account, teamId) => {
  db(`update "User" set roles = array['USER','ADMIN']::"Role"[] where id = ${account.id}`);

  try {
    const token = await trpcAs(account.cookie, 'mutation', 'apiToken.create', {
      teamId,
      tokenName: `visao-${RUN}`,
      expirationDate: null,
    });

    assert.equal(token.status, 200, token.text);

    return data(token).token;
  } finally {
    db(`update "User" set roles = array['USER']::"Role"[] where id = ${account.id}`);
  }
};

const setOwnOnly = (userId, ownOnly) =>
  db(
    `insert into "RevalleUserVisibility" ("userId", "ownOnly", "updatedAt") values (${userId}, ${ownOnly}, now())
       on conflict ("userId") do update set "ownOnly" = excluded."ownOnly", "updatedAt" = now()`,
  );

const newDoc = async (label, { apiToken, recipientEmail }) => {
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({
      recipients: [{ email: recipientEmail ?? `visao-${label}-${RUN}@revalle.com.br` }],
      title: `[TESTE] visao ${label} ${RUN}`,
      apiToken,
    }),
  );

  assert.equal(created.status, 200, created.text);

  return { id: created.id, itemId: created.envelope.envelopeItems[0].id };
};

const apiListIds = async (apiToken) => {
  const res = await api('GET', '/envelope?perPage=100', undefined, { apiToken });

  assert.equal(res.status, 200, res.text);

  return new Set(res.body.data.map((row) => row.id));
};

const screenList = async (cookie, teamId) => {
  const res = await trpcAs(
    cookie,
    'query',
    'document.findDocumentsInternal',
    { perPage: 100, query: RUN },
    { 'x-team-id': String(teamId) },
  );

  return {
    status: res.status,
    ids: new Set((data(res)?.data ?? []).map((row) => row.envelopeId)),
    stats: data(res)?.stats,
  };
};

const searchTitles = async (cookie) => {
  const res = await trpcAs(cookie, 'query', 'document.search', { query: `visao` });

  assert.equal(res.status, 200, res.text);

  return data(res).map((row) => row.title);
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

  units.A = await createUnit('A');
  units.B = await createUnit('B');

  member = await createConfirmedAccount({
    email: `visao-membro-${RUN}@revalle.com.br`,
    name: 'Visao Membro',
    password: PASSWORD,
  });
  colleague = await createConfirmedAccount({
    email: `visao-colega-${RUN}@revalle.com.br`,
    name: 'Visao Colega',
    password: PASSWORD,
  });

  joinOrganisation(units.A.organisationId, member);
  joinOrganisation(units.A.organisationId, colleague);

  member.token = await tokenFor(member, units.A.teamId);
  colleague.token = await tokenFor(colleague, units.A.teamId);

  const adminTeamBToken = data(
    await trpcAs(adminCookie, 'mutation', 'apiToken.create', {
      teamId: units.B.teamId,
      tokenName: `visao-b-${RUN}`,
      expirationDate: null,
    }),
  )?.token;

  assert.ok(adminTeamBToken, 'token do admin no time B não foi criado');

  docs.mine = await newDoc('meu', { apiToken: member.token });
  docs.colleague = await newDoc('colega', { apiToken: colleague.token });
  docs.toMe = await newDoc('para-mim', { apiToken: colleague.token, recipientEmail: member.email });
  docs.otherTeam = await newDoc('outro-time', { apiToken: adminTeamBToken });
});

after(() => {
  if (member?.id) {
    db(`delete from "RevalleUserVisibility" where "userId" in (${member.id}, ${adminId})`);
  }
});

sessionTest('membro vê os documentos do time e não os de outro time', async () => {
  const ids = await apiListIds(member.token);

  assert.ok(ids.has(docs.mine.id) && ids.has(docs.colleague.id) && ids.has(docs.toMe.id), 'faltou documento do time');
  assert.ok(!ids.has(docs.otherTeam.id), 'documento do outro time apareceu na API');
  assert.equal((await api('GET', `/envelope/${docs.otherTeam.id}`, undefined, { apiToken: member.token })).status, 404);

  const screen = await screenList(member.cookie, units.A.teamId);

  assert.equal(screen.status, 200);
  assert.ok(screen.ids.has(docs.colleague.id), 'a lista da tela não trouxe o documento do colega');
  assert.notEqual((await screenList(member.cookie, units.B.teamId)).status, 200, 'abriu a lista de um time de fora');
});

sessionTest('"ver só o seu": o documento do colega some da lista, da busca, da API e do download', async () => {
  setOwnOnly(member.id, true);

  const ids = await apiListIds(member.token);

  assert.ok(ids.has(docs.mine.id), 'o próprio documento sumiu');
  assert.ok(ids.has(docs.toMe.id), 'o documento em que é destinatário sumiu');
  assert.ok(!ids.has(docs.colleague.id), 'o documento do colega continuou na lista da API');

  assert.equal((await api('GET', `/envelope/${docs.colleague.id}`, undefined, { apiToken: member.token })).status, 404);
  assert.equal((await api('GET', `/envelope/${docs.toMe.id}`, undefined, { apiToken: member.token })).status, 200);

  const download = await fetchIdempotent(
    `${BASE_URL}/api/v2-beta/envelope/item/${docs.colleague.itemId}/download?version=original`,
    { headers: { Authorization: `Bearer ${member.token}` } },
    (res) => res.status,
  );

  assert.equal(download, 404, 'o download do documento do colega pela API passou');

  const file = await fetchIdempotent(
    `${BASE_URL}/api/files/envelope/${docs.colleague.id}/envelopeItem/${docs.colleague.itemId}`,
    { headers: { Cookie: member.cookie } },
    (res) => res.status,
  );

  assert.equal(file, 403, 'o arquivo do documento do colega abriu pela sessão');

  const screen = await screenList(member.cookie, units.A.teamId);

  assert.equal(screen.status, 200);
  assert.ok(!screen.ids.has(docs.colleague.id), 'o documento do colega continuou na lista da tela');
  assert.ok(screen.ids.has(docs.mine.id) && screen.ids.has(docs.toMe.id));
  assert.equal(screen.stats.DRAFT, 2, 'o contador de rascunhos contou o documento do colega');

  const titles = await searchTitles(member.cookie);

  assert.ok(!titles.includes(`[TESTE] visao colega ${RUN}`), 'a busca trouxe o documento do colega');

  // O colega, sem a marca, segue vendo tudo do time.
  assert.ok((await apiListIds(colleague.token)).has(docs.mine.id));
});

sessionTest('admin com a marca não é limitado', async () => {
  setOwnOnly(adminId, true);

  try {
    const screen = await screenList(adminCookie, units.A.teamId);

    assert.equal(screen.status, 200, 'o admin não abriu a lista do time A');
    assert.ok(screen.ids.has(docs.colleague.id) && screen.ids.has(docs.mine.id), 'o admin foi limitado');
  } finally {
    setOwnOnly(adminId, false);
  }
});

sessionTest(
  'nota fiscal do espaço pessoal é recusada; "Apenas assinar" no pessoal e NF da unidade passam',
  async () => {
    const draft = async (label, apiToken) => {
      const created = await retryCreateOnStaleSocket(() =>
        createEnvelope({
          recipients: [{ email: `visao-nf-${label}-${RUN}@revalle.com.br` }],
          pdf: danfePdfFile(`visao ${label} ${RUN}`),
          title: `[TESTE NF] visao ${label} ${RUN}`,
          apiToken,
        }),
      );

      assert.equal(created.status, 200, created.text);

      return created.id;
    };
    const classify = async (cookie, envelopeId) =>
      data(await trpcAs(cookie, 'mutation', 'revalle.invoice.classify', { envelopeId }))?.isInvoice;

    // Pessoal: o REVSIGN_API_TOKEN é do time da unidade de teste (bootstrap-creds), então o remetente ganha aqui um token
    // do próprio time pessoal (promoção a ADMIN só na criação do token).
    const userId = Number(db(`select id from "User" where email = '${user.email}'`));
    const personalTeamId = Number(
      db(
        `select t.id from "Team" t join "Organisation" o on o.id = t."organisationId" where o.type = 'PERSONAL' and o."ownerUserId" = ${userId} order by t.id limit 1`,
      ),
    );
    const personalToken = await tokenFor({ id: userId, cookie: userCookie }, personalTeamId);
    const sendPersonal = (envelopeId) =>
      api('POST', '/envelope/distribute', { envelopeId }, { apiToken: personalToken });

    // NF com conta e centro é recusada com a mensagem exata.
    const personal = await draft('pessoal', personalToken);

    assert.equal(await classify(userCookie, personal), 'YES');
    assert.equal((await chooseInvoice({ cookie: userCookie, envelopeId: personal })).status, 200);

    const refused = await sendPersonal(personal);

    assert.equal(refused.status, 400, refused.text);
    assert.ok(refused.text.includes(UNIT_MESSAGE), refused.text);
    assert.equal(db(`select status from "Envelope" where id = '${personal}'`), 'DRAFT');

    // Sem conta escolhida, a recusa do time vem antes da falta de conta.
    const noAccount = await draft('pessoal-sem-conta', personalToken);

    assert.equal(await classify(userCookie, noAccount), 'YES');

    const refusedNoAccount = await sendPersonal(noAccount);

    assert.equal(refusedNoAccount.status, 400, refusedNoAccount.text);
    assert.ok(refusedNoAccount.text.includes(UNIT_MESSAGE), refusedNoAccount.text);

    // "Apenas assinar" no pessoal passa.
    const signOnly = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setInvoiceFlag', {
      envelopeId: personal,
      isInvoice: false,
    });

    assert.equal(signOnly.status, 200, signOnly.text);

    const sent = await sendPersonal(personal);

    assert.equal(sent.status, 200, sent.text);

    // Marcar depois do envio como nota fiscal o que saiu do pessoal também é recusado (mesma mensagem).
    const marked = await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: personal });

    assert.equal(marked.status, 400, marked.text);
    assert.ok(marked.text.includes(UNIT_MESSAGE), marked.text);

    // NF do time da unidade passa.
    const unitInvoice = await draft('unidade', member.token);
    const teamHeader = { 'x-team-id': String(units.A.teamId) };

    assert.equal(await classify(member.cookie, unitInvoice), 'YES');
    assert.equal(
      (await chooseInvoice({ cookie: member.cookie, envelopeId: unitInvoice, headers: teamHeader })).status,
      200,
    );

    const unitSent = await api('POST', '/envelope/distribute', { envelopeId: unitInvoice }, { apiToken: member.token });

    assert.equal(unitSent.status, 200, unitSent.text);
  },
);
