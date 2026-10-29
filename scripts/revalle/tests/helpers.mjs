// Ajudantes dos testes de integração do RevSign (rodam contra a stack local; Node 24+, sem dependências).
// Variáveis: REVSIGN_URL (padrão http://localhost:3000), REVSIGN_API_TOKEN (token de API do time).
// Uso: node --test --test-concurrency=1 scripts/revalle/tests/*.test.mjs (ver revalle/docs/testes.md)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const BASE_URL = (process.env.REVSIGN_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const API = `${BASE_URL}/api/v2-beta`;
const MAILPIT = 'http://localhost:8025/api/v1';
const authHeaders = () => ({ Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` });

const parse = async (res) => {
  const text = await res.text();

  try {
    return { status: res.status, ok: res.ok, body: JSON.parse(text), text };
  } catch {
    return { status: res.status, ok: res.ok, body: undefined, text };
  }
};

// API v2 com token. Devolve { status, ok, body, text } (não lança em erro HTTP).
export const api = async (method, route, body) =>
  parse(
    await fetch(`${API}${route}`, {
      method,
      headers: body ? { ...authHeaders(), 'Content-Type': 'application/json' } : authHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    }),
  );

// Rota tRPC pública (POST), como a página de assinatura chama. O IP vem do proxy em produção; aqui é simulado.
export const trpc = async (procedure, input, headers = {}) =>
  parse(
    await fetch(`${BASE_URL}/api/trpc/${procedure}`, {
      method: 'POST',
      headers: {
        Origin: new URL(BASE_URL).origin,
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.7',
        'User-Agent': 'revsign-gate-test',
        ...headers,
      },
      body: JSON.stringify({ json: input }),
    }),
  );

// Cria um envelope (DOCUMENT por padrão) com um campo de assinatura por destinatário. Devolve { status, ok, body, text, id, envelope }.
export const createEnvelope = async ({
  recipients,
  pdf = 'assets/example.pdf',
  title,
  meta,
  type = 'DOCUMENT',
} = {}) => {
  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title: title ?? `[TESTE] ${new Date().toISOString()}`,
      type,
      meta: { distributionMethod: 'NONE', ...meta },
      recipients: recipients.map((r) => ({
        role: 'SIGNER',
        name: 'Teste',
        fields: [{ type: 'SIGNATURE', page: 1, positionX: 10, positionY: 80, width: 30, height: 8 }],
        ...r,
      })),
    }),
  );
  form.append('files', new File([readFileSync(pdf)], path.basename(pdf), { type: 'application/pdf' }));

  const res = await parse(
    await fetch(`${API}/envelope/create`, { method: 'POST', headers: authHeaders(), body: form }),
  );
  const id = res.body?.id;

  return { ...res, id, envelope: id ? (await api('GET', `/envelope/${id}`)).body : undefined };
};

// Envia o envelope e devolve os destinatários (com token).
export const distribute = async (id) => (await api('POST', '/envelope/distribute', { envelopeId: id })).body.recipients;

// Último e-mail recebido por `to` no Mailpit (ou undefined).
export const latestMail = async (to) => {
  const list = await (await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`)).json();
  const first = list.messages?.[0];

  return first ? await (await fetch(`${MAILPIT}/message/${first.ID}`)).json() : undefined;
};

// Código de 6 dígitos do e-mail mais recente enviado a `to` (Mailpit), ou undefined.
export const getLatestCode = async (to) => {
  const mail = await latestMail(to);

  return mail?.Text?.match(/\b(\d{6})\b/)?.[1] ?? mail?.HTML?.replace(/<[^>]+>/g, ' ').match(/\b(\d{6})\b/)?.[1];
};

// Conclui o documento como a tela faz: pede o código por e-mail, lê no Mailpit e conclui com ele.
// `extra` entra no corpo da conclusão (ex.: nextSigner). Devolve a resposta da conclusão.
export const completeWithCode = async ({ token, documentId, email, extra = {}, headers = {} }) => {
  const before = await getLatestCode(email);
  const requested = await trpc('document.accessAuth.request2FAEmail', { token }, headers);

  if (!requested.ok) {
    return requested;
  }

  let code;

  for (let i = 0; i < 30; i += 1) {
    code = await getLatestCode(email);

    if (code && code !== before) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return trpc(
    'recipient.completeDocumentWithToken',
    { token, documentId, accessAuthOptions: { type: 'TWO_FACTOR_AUTH', method: 'email', token: code }, ...extra },
    headers,
  );
};

// Código de 6 dígitos do e-mail calculado DENTRO do container do app (a chave não sai de lá; só o código volta).
// `periodsAgo`: quantos períodos de 30 s atrás (0 = código atual; a conclusão aceita até 9 atrás, 5 minutos).
export const computeEmailCode = ({ email, envelopeId, periodsAgo = 0 }) => {
  const script = `
    const crypto = require('node:crypto');
    const [email, envelopeId, periodsAgo] = process.argv.slice(1);
    const secret = crypto.createHmac('sha256', process.env.NEXT_PRIVATE_ENCRYPTION_KEY)
      .update('email-2fa|v1|email:' + email + '|id:' + envelopeId).digest();
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) - Number(periodsAgo)));
    const h = crypto.createHmac('sha1', secret).update(counter).digest();
    const o = h[h.length - 1] & 0xf;
    process.stdout.write(String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0'));
  `;

  return execFileSync(
    'docker',
    ['exec', 'revsign-hml-documenso-1', 'node', '-e', script, email, envelopeId, String(periodsAgo)],
    { encoding: 'utf8' },
  ).trim();
};

// Consulta SQL no banco da stack local (psql -At).
export const db = (sql) =>
  execFileSync(
    'docker',
    ['exec', 'revsign-hml-database-1', 'psql', '-U', 'documenso', '-d', 'documenso', '-At', '-c', sql],
    { encoding: 'utf8' },
  ).trim();

// Cookie de sessão por e-mail e senha (fluxo da tela de login: CSRF + authorize). Devolve o valor para o header Cookie.
export const signIn = async (email, password) => {
  const origin = new URL(BASE_URL).origin;
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`, { headers: { Origin: origin } });
  const jar = new Map();

  const collect = (res) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');

      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
  };

  collect(csrfRes);

  const { csrfToken } = await csrfRes.json();
  const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

  const res = await fetch(`${BASE_URL}/api/auth/email-password/authorize`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie() },
    body: JSON.stringify({ email, password, csrfToken }),
  });

  collect(res);

  if (!res.ok) {
    throw new Error(`login falhou (${res.status})`);
  }

  return cookie();
};

// tRPC autenticado por sessão. `kind`: 'query' (GET com input na URL) ou 'mutation' (POST). `extraHeaders` (ex.: x-team-id).
export const trpcAs = async (cookie, kind, procedure, input, extraHeaders = {}) => {
  const origin = new URL(BASE_URL).origin;
  const headers = { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...extraHeaders };

  const res =
    kind === 'query'
      ? await fetch(`${BASE_URL}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`, {
          headers,
        })
      : await fetch(`${BASE_URL}/api/trpc/${procedure}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ json: input }),
        });

  return parse(res);
};
