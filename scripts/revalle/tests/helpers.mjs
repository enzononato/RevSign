// Ajudantes dos testes de integração do RevSign (rodam contra a stack local; Node 24+, sem dependências).
// Variáveis: REVSIGN_URL (padrão http://localhost:3000), REVSIGN_API_TOKEN (token de API do time).
// As funções de API aceitam `apiToken` para agir com outro token (ex.: o do remetente no aceite da Fase 4).
// Uso: node --test --test-concurrency=1 scripts/revalle/tests/*.test.mjs (ver revalle/docs/testes.md)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

export const BASE_URL = (process.env.REVSIGN_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const API = `${BASE_URL}/api/v2-beta`;
const MAILPIT = 'http://localhost:8025/api/v1';
const authHeaders = (apiToken = process.env.REVSIGN_API_TOKEN) => ({ Authorization: `Bearer ${apiToken}` });

// O app fecha conexões ociosas (keep-alive). Depois de uma espera longa (selagem, reselagem, poppler), o fetch pode
// reaproveitar um socket que o servidor já fechou: EPIPE/ECONNRESET ao escrever ou UND_ERR_SOCKET ("other side
// closed") ao ler. Repetir UMA vez é seguro para pedidos idempotentes (GET/HEAD), mesmo que o servidor tenha
// chegado a processar o primeiro.
// POST NÃO é idempotente. A única exceção é a criação de documento (`retryCreateOnStaleSocket`), que repete nos
// mesmos três erros: na prática o UND_ERR_SOCKET aparece justamente no POST da criação (socket ocioso fechado pelo
// servidor), então restringir a EPIPE/ECONNRESET deixaria o teste instável. Risco aceito: se o servidor já tiver
// criado o documento quando a conexão caiu, a repetição cria outro e o primeiro fica como envelope de teste órfão
// (inofensivo na stack local descartável; o teste segue com o segundo). Nenhum outro POST é repetido.
const STALE_SOCKET_CODES = new Set(['EPIPE', 'ECONNRESET', 'UND_ERR_SOCKET']);

export const isStaleSocketError = (error) =>
  STALE_SOCKET_CODES.has(error?.cause?.code) || STALE_SOCKET_CODES.has(error?.code);

// Executa `fn` e, se falhar por socket velho, executa de novo uma única vez. `fn` deve fazer o pedido E ler o corpo.
// Só para pedidos idempotentes; para criar documento use `retryCreateOnStaleSocket` (ver o risco acima).
export const retryOnStaleSocket = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    if (!isStaleSocketError(error)) {
      throw error;
    }

    return fn();
  }
};

// Criação de documento (POST): repete uma vez em socket velho, aceitando o risco de um envelope órfão (ver acima).
export const retryCreateOnStaleSocket = (fn) => retryOnStaleSocket(fn);

// fetch para GET/HEAD com a repetição acima; `read(res)` lê o corpo dentro da repetição (padrão: parse).
export const fetchIdempotent = (url, init = {}, read = parse) => {
  const method = (init.method ?? 'GET').toUpperCase();

  if (method !== 'GET' && method !== 'HEAD') {
    throw new Error(`fetchIdempotent só repete GET/HEAD (recebeu ${method})`);
  }

  return retryOnStaleSocket(async () => read(await fetch(url, init)));
};

const parse = async (res) => {
  const text = await res.text();

  try {
    return { status: res.status, ok: res.ok, body: JSON.parse(text), text };
  } catch {
    return { status: res.status, ok: res.ok, body: undefined, text };
  }
};

// API v2 com token. Devolve { status, ok, body, text } (não lança em erro HTTP). GET repete em socket velho.
export const api = async (method, route, body, { apiToken } = {}) => {
  if (method === 'GET' && !body) {
    return fetchIdempotent(`${API}${route}`, { headers: authHeaders(apiToken) });
  }

  return parse(
    await fetch(`${API}${route}`, {
      method,
      headers: body ? { ...authHeaders(apiToken), 'Content-Type': 'application/json' } : authHeaders(apiToken),
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
};

// Baixa um item do envelope (`version`: original, signed ou pending) como Buffer; lança se o status não for 200.
export const downloadItem = (itemId, version, { apiToken } = {}) =>
  fetchIdempotent(
    `${API}/envelope/item/${itemId}/download?version=${version}`,
    { headers: authHeaders(apiToken) },
    async (res) => {
      if (res.status !== 200) {
        throw new Error(`download ${version}: HTTP ${res.status} ${await res.text()}`);
      }

      return Buffer.from(await res.arrayBuffer());
    },
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
  apiToken,
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
    await fetch(`${API}/envelope/create`, { method: 'POST', headers: authHeaders(apiToken), body: form }),
  );
  const id = res.body?.id;

  return { ...res, id, envelope: id ? (await api('GET', `/envelope/${id}`, undefined, { apiToken })).body : undefined };
};

// Envia o envelope e devolve os destinatários (com token).
export const distribute = async (id, { apiToken } = {}) =>
  (await api('POST', '/envelope/distribute', { envelopeId: id }, { apiToken })).body.recipients;

// Último e-mail recebido por `to` no Mailpit (ou undefined).
const mailpitJson = (url) => fetchIdempotent(url, {}, (res) => res.json());

export const latestMail = async (to) => {
  const list = await mailpitJson(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`);
  const first = list.messages?.[0];

  return first ? await mailpitJson(`${MAILPIT}/message/${first.ID}`) : undefined;
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
  const jar = new Map();

  const collect = (res) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');

      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
  };

  const { csrfToken } = await fetchIdempotent(`${BASE_URL}/api/auth/csrf`, { headers: { Origin: origin } }, (res) => {
    collect(res);

    return res.json();
  });
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

  if (kind === 'query') {
    return fetchIdempotent(
      `${BASE_URL}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
      { headers },
    );
  }

  return parse(
    await fetch(`${BASE_URL}/api/trpc/${procedure}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ json: input }),
    }),
  );
};

// Roda ferramentas do poppler (pdftotext, pdfinfo, pdfimages...) num container alpine com `dir` montado em /pdf.
export const poppler = (dir, script) =>
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${dir}:/pdf:ro`,
      'alpine:3.22',
      'sh',
      '-c',
      `apk add --no-cache -q poppler-utils >/dev/null && ${script}`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

// dd/MM/yyyy HH:mm no fuso de Brasília (America/Bahia), como o carimbo, o certificado e o /verificar.
export const brasilia = (date) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Bahia',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(date))
      .map((part) => [part.type, part.value]),
  );

  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
};

// PNG 60×20 com um traço, como data URL (um "desenho" pequeno de verdade, sem depender de arquivo).
export const drawingPng = () => {
  const width = 60;
  const height = 20;
  const rows = [];

  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4, 0);

    for (let x = 0; x < width; x += 1) {
      const isInk = Math.abs(y - Math.round((x * (height - 1)) / (width - 1))) <= 1;

      row.writeUInt32BE(isInk ? 0x000000ff : 0x00000000, 1 + x * 4);
    }

    rows.push(row);
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    const crc = Buffer.alloc(4);
    const body = Buffer.concat([Buffer.from(type), data]);

    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));

    return Buffer.concat([length, body, crc]);
  };

  const header = Buffer.alloc(13);

  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  return `data:image/png;base64,${png.toString('base64')}`;
};
