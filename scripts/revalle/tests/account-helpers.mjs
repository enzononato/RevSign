// Conta obrigatória para quem assina pelo e-mail da empresa (decisão de 16/11/2026): ajudantes dos testes.
//
// Desde essa versão, toda ação pelo link (assinar campo, concluir, recusar, portão, código por e-mail, PDF pendente) de
// um destinatário do e-mail da empresa que ainda precisa agir exige a sessão da conta desse e-mail. Os testes antigos
// agiam pelo token sem sessão; para eles, `account-autologin.mjs` (uma linha de import) liga o login automático abaixo.
//
// As contas de teste criadas aqui entram direto no banco (e-mail já confirmado, senha conhecida): o cadastro de verdade,
// com CPF e confirmação, é testado em `account-required.test.mjs` e `signup-identity.test.mjs`.

import { appContainerEnv, BASE_URL, db, fetchIdempotent } from './helpers.mjs';

// Senha só das contas de teste da stack local (sem valor fora dela), montada por partes como as outras senhas de teste
// (que vêm do RUN); o hash abaixo é o bcrypt (custo 12) dela.
export const TEST_ACCOUNT_PASSWORD = ['Conta', 'Teste', 'RevSign', '2026'].join('-');
const TEST_ACCOUNT_HASH = '$2y$12$81Vz6foj8FYNwfvdK/UB..z2EzamqRzaIbPhdQbLlZkzZjm3v8RbC';

const originalFetch = globalThis.fetch;
const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
const randomTestIp = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}`;

// Senhas conhecidas de contas que já existem (as do .env dos testes e as que um teste cria e registra aqui).
const knownPasswords = new Map();

export const registerAccountPassword = (email, password) => {
  if (email && password) {
    knownPasswords.set(email.trim().toLowerCase(), password);
  }
};

registerAccountPassword(process.env.REVSIGN_USER_EMAIL, process.env.REVSIGN_USER_PASSWORD);
registerAccountPassword(process.env.REVSIGN_ADMIN_EMAIL, process.env.REVSIGN_ADMIN_PASSWORD);

let companyDomains;

/** Domínios da empresa, lidos do container do app (NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS). */
export const getCompanyDomains = () => {
  companyDomains ??= appContainerEnv('NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);

  return companyDomains;
};

export const isCompanyEmail = (email) => {
  const domain = String(email ?? '')
    .trim()
    .toLowerCase()
    .split('@')
    .pop();

  return getCompanyDomains().includes(domain);
};

/** A mesma regra do servidor (`revalle/account-required/rule.ts`). */
export const needsAccount = ({ email, role, signingStatus }) =>
  signingStatus === 'NOT_SIGNED' && role !== 'CC' && role !== 'VIEWER' && isCompanyEmail(email);

/** Conta de teste pronta (e-mail confirmado, senha TEST_ACCOUNT_PASSWORD). Não mexe numa conta que já existe. */
export const ensureTestAccount = (email, name = 'Conta de Teste') => {
  const normalized = email.trim().toLowerCase();

  db(
    `insert into "User" (name, email, "emailVerified", password, "updatedAt") values (${sql(name)}, ${sql(normalized)}, now(), ${sql(TEST_ACCOUNT_HASH)}, now()) on conflict (email) do nothing`,
  );

  return normalized;
};

/** Login por e-mail e senha como a tela faz (CSRF + authorize), com IP de teste sorteado. Devolve o header Cookie. */
export const signInAs = async (email, password = TEST_ACCOUNT_PASSWORD) => {
  const origin = new URL(BASE_URL).origin;
  const ip = randomTestIp();
  const jar = new Map();

  const collect = (res) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');

      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
  };

  const { csrfToken } = await fetchIdempotent(
    `${BASE_URL}/api/auth/csrf`,
    { headers: { Origin: origin, 'X-Forwarded-For': ip } },
    (res) => {
      collect(res);

      return res.json();
    },
  );
  const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

  const res = await originalFetch(`${BASE_URL}/api/auth/email-password/authorize`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': ip, Cookie: cookie() },
    body: JSON.stringify({ email, password, csrfToken }),
  });

  collect(res);

  if (!res.ok) {
    throw new Error(`login de ${email} falhou (${res.status}): ${await res.text()}`);
  }

  return cookie();
};

const sessions = new Map();

/** Cookie da conta do e-mail (cria a conta de teste se não existir). Guarda o cookie por e-mail. */
export const sessionFor = async (email) => {
  const normalized = email.trim().toLowerCase();

  if (!sessions.has(normalized)) {
    const existed = db(`select count(*) from "User" where email = ${sql(normalized)}`) !== '0';

    if (!existed) {
      ensureTestAccount(normalized);
    }

    const known = knownPasswords.get(normalized);

    try {
      sessions.set(normalized, await signInAs(normalized, known ?? TEST_ACCOUNT_PASSWORD));
    } catch (error) {
      throw new Error(
        `${error.message}. A conta ${normalized} já existia com outra senha: registre-a com registerAccountPassword ou passe o Cookie`,
      );
    }
  }

  return sessions.get(normalized);
};

/** Cookie do destinatário dono do token, se ele precisa da conta; senão null. */
export const recipientSessionFor = async (token) => {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(token)) {
    return null;
  }

  const row = db(`select email || '|' || role || '|' || "signingStatus" from "Recipient" where token = ${sql(token)}`);

  if (!row) {
    return null;
  }

  const [email, role, signingStatus] = row.split('|');

  return needsAccount({ email, role, signingStatus }) ? await sessionFor(email) : null;
};

// Procura o token do destinatário no input tRPC (`token`, `recipientToken` ou `access.token`, até 3 níveis).
const findToken = (value, depth = 0) => {
  if (!value || typeof value !== 'object' || depth > 3) {
    return null;
  }

  for (const key of ['token', 'recipientToken']) {
    if (typeof value[key] === 'string') {
      return value[key];
    }
  }

  for (const child of Object.values(value)) {
    const found = findToken(child, depth + 1);

    if (found) {
      return found;
    }
  }

  return null;
};

const tokenOfRequest = (url, init) => {
  const path = url.pathname;
  const page = /^\/sign\/([A-Za-z0-9_-]+)(\/|$)/.exec(path) ?? /^\/api\/files\/token\/([A-Za-z0-9_-]+)\//.exec(path);

  if (page) {
    return page[1];
  }

  if (!path.startsWith('/api/trpc/')) {
    return null;
  }

  try {
    if (typeof init?.body === 'string') {
      return findToken(JSON.parse(init.body));
    }

    const input = url.searchParams.get('input');

    return input ? findToken(JSON.parse(input)) : null;
  } catch {
    return null;
  }
};

let installed = false;

/**
 * Liga o login automático nos pedidos ao app: um pedido sem Cookie que age com o token de um destinatário que precisa da
 * conta (e-mail da empresa, assina/aprova, ainda não concluiu) sai com o cookie da conta dele. Pedidos com Cookie
 * explícito não mudam. Só para os testes escritos antes da regra; os testes da regra não usam isto.
 */
export const installCompanyRecipientAutoLogin = () => {
  if (installed) {
    return;
  }

  installed = true;

  globalThis.fetch = async (input, init = undefined) => {
    if (typeof input !== 'string' && !(input instanceof URL)) {
      return originalFetch(input, init);
    }

    const url = new URL(String(input), BASE_URL);

    if (url.origin !== new URL(BASE_URL).origin) {
      return originalFetch(input, init);
    }

    // Senha de conta criada ou usada pelo próprio teste (cadastro, login): fica conhecida para o login automático.
    if (/^\/api\/auth\/email-password\/(signup|authorize)$/.test(url.pathname) && typeof init?.body === 'string') {
      try {
        const { email, password } = JSON.parse(init.body);

        registerAccountPassword(email, password);
      } catch {
        // corpo que não é JSON: segue
      }
    }

    const headers = new Headers(init?.headers);

    if (headers.has('cookie')) {
      return originalFetch(input, init);
    }

    const cookie = await recipientSessionFor(tokenOfRequest(url, init));

    if (!cookie) {
      return originalFetch(input, init);
    }

    headers.set('Cookie', cookie);

    return originalFetch(input, { ...init, headers });
  };
};
