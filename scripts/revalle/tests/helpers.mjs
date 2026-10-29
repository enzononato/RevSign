// Ajudantes dos testes de integração do RevSign (rodam contra a stack local; Node 24+, sem dependências).
// Variáveis: REVSIGN_URL (padrão http://localhost:3000), REVSIGN_API_TOKEN (token de API do time).
// Uso: node --test scripts/revalle/tests/

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

// Cria um envelope com um campo de assinatura por destinatário. Devolve { status, ok, body, text, id, envelope }.
export const createEnvelope = async ({ recipients, pdf = 'assets/example.pdf', title, meta } = {}) => {
  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title: title ?? `[TESTE] ${new Date().toISOString()}`,
      type: 'DOCUMENT',
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

// Consulta SQL no banco da stack local (psql -At).
export const db = (sql) =>
  execFileSync(
    'docker',
    ['exec', 'revsign-hml-database-1', 'psql', '-U', 'documenso', '-d', 'documenso', '-At', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
