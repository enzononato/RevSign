// Recria as contas e os tokens de API da suíte de integração na stack LOCAL (revsign-hml) depois de o banco de teste
// ser apagado. Node 24+, sem dependências. Idempotente: conta que já entra e token que já funciona ficam como estão.
//
// Uso: node scripts/revalle/tests/bootstrap-creds.mjs
//
// Credenciais (fora do git, chmod 600) em ../local-hml/test-creds/ (ou REVSIGN_CREDS_DIR):
//   admin.pw       senha de admin@hml.local (REVSIGN_USER_*, conta comum)
//   rsadmin.pw     senha de rsadmin.f3@revalle.com.br (REVSIGN_ADMIN_*, ADMIN)
//   api.token      REVSIGN_API_TOKEN: token do time pessoal de admin@hml.local (regravado aqui)
//   rsadmin.token  REVSIGN_SENDER_API_TOKEN: token do time pessoal de rsadmin (regravado aqui)
//
// Só pelos fluxos do app, nunca INSERT de conta ou token:
//   - rsadmin: cadastro com o CPF fictício 7 do dev-seed.sql (o mesmo a que o aceite da Fase 4 liga o remetente),
//     confirmação pelo link do Mailpit e papel ADMIN pela promoção documentada em revalle/docs/testes.md ("O que precisa
//     estar de pé", item 4), que aqui fica (é a conta ADMIN dos testes). A subida do app só promove
//     NEXT_PRIVATE_REVALLE_ADMIN_EMAIL, que na stack local é outra conta.
//   - admin@hml.local: `hml.local` não é domínio da empresa (os testes contam com isso), então o cadastro o recusa. Quem
//     cria é o admin (rsadmin) pela rota `admin.user.create`; a senha vem pelo link do e-mail "conta criada" (Mailpit,
//     /reset-password) e a organização pessoal nasce no primeiro getOrganisationSession (ensurePersonalOrganisation).
//   - Tokens: `apiToken.create` com a sessão da conta, no time pessoal dela. Só ADMIN cria token: admin@hml.local é
//     promovido por instantes e volta a USER (o token continua valendo).
// Nunca imprime senha nem token.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { api, BASE_URL, db, mailIdsTo, signIn, trpcAs, waitNewMail } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CREDS_DIR = process.env.REVSIGN_CREDS_DIR ?? path.resolve(here, '../../../../local-hml/test-creds');

const USER_EMAIL = 'admin@hml.local';
const ADMIN_EMAIL = 'rsadmin.f3@revalle.com.br';
// CPF fictício 7 (Teste Aceite F4 1) de revalle/colaboradores/dev-seed.sql.
const ADMIN_IDENTITY = { cpf: '41000000141', birthDate: '12/05/1987' };
const TOKEN_NAME = 'testes-locais';

const origin = new URL(BASE_URL).origin;
const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
const randomTestIp = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}`;

const readSecret = (file) => {
  const full = path.join(CREDS_DIR, file);

  if (!existsSync(full)) {
    return null;
  }

  const value = readFileSync(full, 'utf8').replace(/\r?\n$/, '');

  if (value) {
    secrets.add(value);
  }

  return value;
};

const writeSecret = (file, value) => {
  const full = path.join(CREDS_DIR, file);

  writeFileSync(full, value, { mode: 0o600 });
  chmodSync(full, 0o600);
};

const postJson = async (route, body) => {
  const res = await fetch(`${BASE_URL}${route}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': randomTestIp() },
    body: JSON.stringify(body),
  });

  return { status: res.status, ok: res.ok, text: await res.text() };
};

// Segredos lidos ou criados aqui: saem de qualquer mensagem de erro (o corpo da resposta poderia repetir o pedido).
const secrets = new Set();
const scrub = (text) => [...secrets].reduce((out, secret) => out.replaceAll(secret, '***'), String(text ?? ''));

const failure = (what, res) => new Error(`${what} falhou (${res.status}): ${scrub(res.text).slice(0, 300)}`);

const userRow = (email) => {
  const row = db(
    `select id || '|' || ("emailVerified" is not null) || '|' || array_to_string(roles, ',') || '|' || (password is not null) from "User" where email = ${sql(email)}`,
  );

  if (!row) {
    return null;
  }

  const [id, verified, roles, hasPassword] = row.split('|');

  return {
    id: Number(id),
    verified: verified === 'true',
    roles: roles.split(','),
    hasPassword: hasPassword === 'true',
  };
};

const setRoles = (email, roles) =>
  db(`update "User" set roles = array[${roles.map(sql).join(',')}]::"Role"[] where email = ${sql(email)}`);

const tryLogin = async (email, password) => {
  try {
    return await signIn(email, password);
  } catch {
    return null;
  }
};

const linkFrom = (mail, pattern) => mail.HTML?.match(pattern)?.[1] ?? mail.Text?.match(pattern)?.[1];

const confirmEmail = async (email, seen) => {
  const mail = await waitNewMail(email, seen, {
    what: 'E-mail de confirmação da conta',
    matches: (m) => Boolean(linkFrom(m, /\/verify-email\/([A-Za-z0-9_-]+)/)),
  });
  const res = await postJson('/api/auth/email-password/verify-email', {
    token: linkFrom(mail, /\/verify-email\/([A-Za-z0-9_-]+)/),
  });

  if (res.status !== 200) {
    throw failure(`confirmação de ${email}`, res);
  }
};

// Define a senha pelo link /reset-password/<token> do primeiro e-mail novo que o trouxer.
const setPasswordFromMail = async (email, seen, password, what) => {
  const mail = await waitNewMail(email, seen, {
    what,
    matches: (m) => Boolean(linkFrom(m, /\/reset-password\/([A-Za-z0-9_-]+)/)),
  });
  const res = await postJson('/api/auth/email-password/reset-password', {
    token: linkFrom(mail, /\/reset-password\/([A-Za-z0-9_-]+)/),
    password,
  });

  if (!res.ok) {
    throw failure(`definição da senha de ${email}`, res);
  }
};

// Conta existente que não entra: confirma o e-mail pendente ou redefine a senha pelo "esqueci a senha".
const repairLogin = async (email, password) => {
  const row = userRow(email);

  if (!row.verified) {
    const seen = await mailIdsTo(email);
    const res = await postJson('/api/auth/email-password/resend-verify-email', { email });

    if (!res.ok) {
      throw failure(`reenvio da confirmação de ${email}`, res);
    }

    await confirmEmail(email, seen);
  }

  let cookie = await tryLogin(email, password);

  if (!cookie) {
    const seen = await mailIdsTo(email);
    const res = await postJson('/api/auth/email-password/forgot-password', { email });

    if (!res.ok) {
      throw failure(`pedido de nova senha de ${email}`, res);
    }

    await setPasswordFromMail(email, seen, password, 'E-mail de nova senha');
    cookie = await tryLogin(email, password);
  }

  if (!cookie) {
    throw new Error(`conta ${email}: existe mas não entra com a senha do arquivo`);
  }

  return cookie;
};

const ensureAdminAccount = async (password) => {
  let status = 'ok';

  if (!userRow(ADMIN_EMAIL)) {
    const seen = await mailIdsTo(ADMIN_EMAIL);
    const res = await postJson('/api/auth/email-password/signup', {
      name: 'RS Admin Testes',
      email: ADMIN_EMAIL,
      password,
      revalleCpf: ADMIN_IDENTITY.cpf,
      revalleBirthDate: ADMIN_IDENTITY.birthDate,
    });

    if (res.status !== 201) {
      throw failure(`cadastro de ${ADMIN_EMAIL}`, res);
    }

    await confirmEmail(ADMIN_EMAIL, seen);
    status = 'criada';
  }

  const cookie = (await tryLogin(ADMIN_EMAIL, password)) ?? (await repairLogin(ADMIN_EMAIL, password));

  if (!userRow(ADMIN_EMAIL).roles.includes('ADMIN')) {
    setRoles(ADMIN_EMAIL, ['USER', 'ADMIN']);
    status += ' (promovida a ADMIN)';
  }

  console.log(`conta ${ADMIN_EMAIL}: ${status}`);

  return cookie;
};

const ensureUserAccount = async (password, adminCookie) => {
  let status = 'ok';

  if (!userRow(USER_EMAIL)) {
    const seen = await mailIdsTo(USER_EMAIL);
    const res = await trpcAs(adminCookie, 'mutation', 'admin.user.create', { email: USER_EMAIL, name: 'Admin HML' });

    if (!res.ok) {
      throw failure(`criação de ${USER_EMAIL} pelo admin`, res);
    }

    await setPasswordFromMail(USER_EMAIL, seen, password, 'E-mail de conta criada');
    status = 'criada';
  }

  const cookie = (await tryLogin(USER_EMAIL, password)) ?? (await repairLogin(USER_EMAIL, password));

  console.log(`conta ${USER_EMAIL}: ${status}`);

  return cookie;
};

// Time pessoal da conta. O getOrganisationSession cria a organização pessoal de quem ainda não tem (conta do admin).
const personalTeamId = async (email, cookie) => {
  const session = await trpcAs(cookie, 'query', 'organisation.internal.getOrganisationSession', undefined);

  if (!session.ok) {
    throw failure(`sessão de organização de ${email}`, session);
  }

  const teamId = db(
    `select t.id from "Team" t join "Organisation" o on o.id = t."organisationId" join "User" u on u.id = o."ownerUserId" where o.type = 'PERSONAL' and u.email = ${sql(email)} order by t.id limit 1`,
  );

  if (!teamId) {
    throw new Error(`conta ${email}: sem time pessoal`);
  }

  return Number(teamId);
};

// O token do arquivo vale se é desta conta, deste time, não venceu e a API v2 o aceita.
const tokenWorks = async (token, email, teamId) => {
  if (!token) {
    return false;
  }

  const hash = createHash('sha512').update(token).digest('hex');
  const owner = db(
    `select u.email || '|' || a."teamId" from "ApiToken" a join "User" u on u.id = a."userId" where a.token = ${sql(hash)} and (a.expires is null or a.expires > now())`,
  );

  if (owner !== `${email}|${teamId}`) {
    return false;
  }

  return (await api('GET', '/envelope', undefined, { apiToken: token })).status === 200;
};

const ensureToken = async ({ email, cookie, file, temporaryAdmin }) => {
  const teamId = await personalTeamId(email, cookie);

  if (await tokenWorks(readSecret(file), email, teamId)) {
    console.log(`token ${file}: ok`);

    return;
  }

  const promote = temporaryAdmin && !userRow(email).roles.includes('ADMIN');

  if (promote) {
    setRoles(email, ['USER', 'ADMIN']);
  }

  try {
    const res = await trpcAs(cookie, 'mutation', 'apiToken.create', {
      teamId,
      tokenName: TOKEN_NAME,
      expirationDate: null,
    });
    const token = res.body?.result?.data?.json?.token;

    if (!res.ok || !token) {
      throw new Error(`criação do token ${file} falhou (${res.status})`);
    }

    writeSecret(file, token);
  } finally {
    if (promote) {
      setRoles(email, ['USER']);
    }
  }

  console.log(`token ${file}: gravado`);
};

const adminPassword = readSecret('rsadmin.pw');
const userPassword = readSecret('admin.pw');

if (!adminPassword || !userPassword) {
  console.error(`faltam rsadmin.pw ou admin.pw em ${CREDS_DIR}`);
  process.exit(1);
}

const adminCookie = await ensureAdminAccount(adminPassword);
const userCookie = await ensureUserAccount(userPassword, adminCookie);

await ensureToken({ email: USER_EMAIL, cookie: userCookie, file: 'api.token', temporaryAdmin: true });
await ensureToken({ email: ADMIN_EMAIL, cookie: adminCookie, file: 'rsadmin.token', temporaryAdmin: false });

const roles = userRow(USER_EMAIL).roles.join(',');

console.log(`papéis: ${USER_EMAIL}=${roles}; ${ADMIN_EMAIL}=${userRow(ADMIN_EMAIL).roles.join(',')}`);
