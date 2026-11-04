// Ajudantes dos testes de integração do RevSign (rodam contra a stack local; Node 24+, sem dependências).
// Variáveis: REVSIGN_URL (padrão http://localhost:3000), REVSIGN_API_TOKEN (token de API do time).
// As funções de API aceitam `apiToken` para agir com outro token (ex.: o do remetente no aceite da Fase 4).
// Uso: node --test --test-concurrency=1 scripts/revalle/tests/*.test.mjs (ver revalle/docs/testes.md)

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// O relógio da máquina pode saltar. No WSL2, com a hora do Windows atrasada, ele volta de 9 a 12 s e adianta de novo a
// cada 32 s (ver revalle/docs/testes.md), e app, banco, Mailpit e testes dividem esse relógio. Por isso, nos testes: prazo
// com `performance.now()`, e "o que veio depois" pela identidade (ID do e-mail, xmin da linha), nunca pela data.

const mailpitJson = (url) => fetchIdempotent(url, {}, (res) => res.json());

export const mailsTo = async (to) =>
  (await mailpitJson(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`)).messages ?? [];

export const mailById = (id) => mailpitJson(`${MAILPIT}/message/${id}`);

// O e-mail do topo da lista de `to` (ou undefined). Só serve para endereço novo, com um e-mail só (ver `mailIdsTo`).
export const latestMail = async (to) => {
  const [first] = await mailsTo(to);

  return first ? await mailById(first.ID) : undefined;
};

// IDs dos e-mails que `to` já recebeu: guarde antes da ação e passe a `waitNewMail`. O Mailpit ordena pela data de
// chegada no relógio da máquina, então "o primeiro da lista" não é o mais novo depois de um salto para trás.
export const mailIdsTo = async (to) => new Set((await mailsTo(to)).map((message) => message.ID));

// Primeiro e-mail completo que chegou a `to` depois do retrato `seen` e passa em `matches`. Lança se não vier no prazo.
export const waitNewMail = async (to, seen, { matches = () => true, what = 'e-mail', timeoutMs = 60_000 } = {}) => {
  const checked = new Set(seen);
  const deadline = performance.now() + timeoutMs;

  do {
    for (const { ID } of await mailsTo(to)) {
      if (!checked.has(ID)) {
        checked.add(ID);

        const mail = await mailById(ID);

        if (matches(mail)) {
          return mail;
        }
      }
    }

    await sleep(200);
  } while (performance.now() < deadline);

  throw new Error(`${what} não chegou a ${to} em ${timeoutMs / 1000} s`);
};

// O código fica sozinho numa linha. Procurar 6 dígitos em qualquer lugar pegaria um número do título do documento,
// que vem antes no texto.
export const emailCodeOf = (mail) => mail.Text?.match(/^\s*(\d{6})\s*$/m)?.[1];

// Pede o código como a tela faz e o lê do e-mail que este pedido gerou. Devolve { requested, code }; se o pedido foi
// recusado, só { requested }.
export const requestEmailCode = async ({ token, email, headers = {} }) => {
  const seen = await mailIdsTo(email);
  const requested = await trpc('document.accessAuth.request2FAEmail', { token }, headers);

  if (!requested.ok) {
    return { requested };
  }

  const mail = await waitNewMail(email, seen, { matches: emailCodeOf, what: 'E-mail com o código' });

  return { requested, code: emailCodeOf(mail) };
};

// O código vale do período de 30 s atual para trás, nunca para a frente. Se o relógio volta entre gerar e conferir,
// passando para o período anterior, o código certo é recusado até o relógio chegar de novo aonde estava. Confere, com a
// chave do app, se é esse o caso (o código é o do período atual ou o do próximo): se for, espera ele valer e devolve true.
// Qualquer outro código é uma recusa de verdade e devolve false.
const waitUntilCodeIsValid = async ({ token, code }) => {
  const [email, envelopeId] = db(`select email || '|' || "envelopeId" from "Recipient" where token = '${token}'`).split(
    '|',
  );
  const codeOfPeriod = (periodsAgo) => computeEmailCode({ email, envelopeId, periodsAgo });

  if (codeOfPeriod(0) !== code && codeOfPeriod(-1) !== code) {
    return false;
  }

  const deadline = performance.now() + 45_000;

  while (codeOfPeriod(0) !== code && performance.now() < deadline) {
    await sleep(1000);
  }

  return true;
};

// Conclui com um código pedido em `requestEmailCode` (`extra` entra no corpo, ex.: nextSigner). Devolve a resposta.
export const completeWithSentCode = async ({ token, documentId, code, extra = {}, headers = {} }) => {
  const complete = () =>
    trpc(
      'recipient.completeDocumentWithToken',
      { token, documentId, accessAuthOptions: { type: 'TWO_FACTOR_AUTH', method: 'email', token: code }, ...extra },
      headers,
    );
  const first = await complete();

  if (first.text.includes('TWO_FACTOR_AUTH_FAILED') && (await waitUntilCodeIsValid({ token, code }))) {
    return complete();
  }

  return first;
};

// Conclui o documento como a tela faz: pede o código por e-mail, lê no Mailpit e conclui com ele.
// `extra` entra no corpo da conclusão (ex.: nextSigner). Devolve a resposta da conclusão.
export const completeWithCode = async ({ token, documentId, email, extra = {}, headers = {} }) => {
  const { requested, code } = await requestEmailCode({ token, email, headers });

  if (!requested.ok) {
    return requested;
  }

  return completeWithSentCode({ token, documentId, code, extra, headers });
};

// Código de 6 dígitos do e-mail calculado DENTRO do container do app (a chave não sai de lá; só o código volta).
// `periodsAgo`: quantos períodos de 30 s atrás (a conclusão aceita até 9 atrás, 5 minutos). O padrão é 1: o período atual
// viraria um código "futuro" se o relógio voltasse antes da conferência (ver `waitUntilCodeIsValid`), e um período atrás
// não.
export const computeEmailCode = ({ email, envelopeId, periodsAgo = 1 }) => {
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

// Colaboradora fictícia dos cadastros de teste (revalle/colaboradores/dev-seed.sql, "Teste Cadastro"). Sem e-mail na base.
export const SIGNUP_COLABORADOR = { cpf: '11144477735', birthDate: '03/02/1991' };

// IP de teste (faixa TEST-NET-3) sorteado a cada cadastro: `auth.signup` conta por IP (30 por hora), então um IP
// fixo esgotaria o limite no meio da suíte. Com 250 endereços, nenhum chega perto do teto.
const randomTestIp = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}`;

// POST do cadastro, como a tela faz (Fase 7: CPF e data de nascimento). Devolve a Response do `fetch`, sem lançar.
// `revalleCpf` e `revalleBirthDate` entram no corpo só quando informados (para testar o cadastro sem eles).
const fetchSignup = ({ name, email, password, revalleCpf, revalleBirthDate, headers = {} }) =>
  fetch(`${BASE_URL}/api/auth/email-password/signup`, {
    method: 'POST',
    headers: {
      Origin: new URL(BASE_URL).origin,
      'Content-Type': 'application/json',
      'X-Forwarded-For': randomTestIp(),
      ...headers,
    },
    body: JSON.stringify({ name, email, password, revalleCpf, revalleBirthDate }),
  });

// Igual a `fetchSignup`, mas já lida: { status, ok, body, text }.
export const postSignup = async (input) => parse(await fetchSignup(input));

// Cria uma conta de teste como colaboradora "Teste Cadastro". O vínculo e-mail ↔ CPF é único e nasce quando a conta
// confirma o e-mail, então a conta anterior do mesmo CPF seguraria o vínculo e a próxima receberia
// SIGNUP_IDENTITY_CONFLICT: por isso solta o vínculo desse CPF antes de cadastrar. Também zera a trava de 10 conferências
// por CPF a cada 24 horas (`revalle.signup-identity`): todas as contas de teste usam o mesmo CPF e passariam do limite.
// Devolve a Response do `fetch` (como os testes antigos já usavam: `created.ok`, `await created.text()`).
export const signupColaborador = ({ name, email, password, headers }) => {
  db(`delete from "RevalleEmailLink" where cpf = '${SIGNUP_COLABORADOR.cpf}'`);
  db(`delete from "RateLimit" where action = 'revalle.signup-identity'`);

  return fetchSignup({
    name,
    email,
    password,
    revalleCpf: SIGNUP_COLABORADOR.cpf,
    revalleBirthDate: SIGNUP_COLABORADOR.birthDate,
    headers,
  });
};

// Conta nova e pronta: cadastro como colaboradora "Teste Cadastro" (ver `signupColaborador`), confirmação pelo link do
// Mailpit e login. Devolve { email, name, id, cookie }.
export const createConfirmedAccount = async ({ email, name, password }) => {
  const seen = await mailIdsTo(email);
  const created = await signupColaborador({ name, email, password });

  if (!created.ok) {
    throw new Error(`cadastro de ${email} falhou (${created.status}): ${await created.text()}`);
  }

  const mail = await waitNewMail(email, seen, { what: 'E-mail de confirmação da conta' });
  const token = mail.HTML?.match(/\/verify-email\/([A-Za-z0-9_-]+)/)?.[1];

  if (!token) {
    throw new Error(`e-mail de confirmação de ${email} sem o link`);
  }

  const verified = await fetch(`${BASE_URL}/api/auth/email-password/verify-email`, {
    method: 'POST',
    headers: { Origin: new URL(BASE_URL).origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  if (verified.status !== 200) {
    throw new Error(`confirmação de ${email} falhou (${verified.status}): ${await verified.text()}`);
  }

  return {
    email,
    name,
    id: Number(db(`select id from "User" where email = '${email}'`)),
    cookie: await signIn(email, password),
  };
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

// Escolhe a conta contábil e o centro de custo de uma NF em rascunho, como a tela faz (duas rotas). NF só é enviada com
// os dois (Fase 7): todo teste que envia NF passa por aqui. `code` ou `costCenter` nulo pula a etapa (para testar o
// envio com só um dos dois). Devolve a resposta da primeira etapa que falhou ou, se todas passaram, a da última.
export const chooseInvoice = async ({ cookie, envelopeId, code = '2.1.03', costCenter = '101', headers = {} }) => {
  let last;

  if (code !== null) {
    last = await trpcAs(cookie, 'mutation', 'revalle.invoice.setChoice', { envelopeId, choice: { code } }, headers);

    if (!last.ok) {
      return last;
    }
  }

  if (costCenter !== null) {
    last = await trpcAs(cookie, 'mutation', 'revalle.invoice.setCostCenter', { envelopeId, code: costCenter }, headers);
  }

  return last;
};

// Os dois e-mails de fluxo que saíram na Fase 7 (assunto antigo) e os jobs que os mandavam.
export const WORKFLOW_SUBJECT = /^Nota fiscal (assinada|aguardando aprovação do Financeiro): /;
const WORKFLOW_JOBS = ['send.revalle.invoice.accounting.email', 'send.revalle.finance.approval.email'];

// E-mails de fluxo de uma NF na caixa inteira (o assunto antigo leva o título único): têm de ser zero.
export const workflowMails = async (doc) =>
  ((await mailpitJson(`${MAILPIT}/search?query=${encodeURIComponent(`subject:"${doc.title}"`)}`)).messages ?? [])
    .filter((message) => WORKFLOW_SUBJECT.test(message.Subject))
    .map((message) => `${message.Subject} -> ${message.To.map((to) => to.Address)}`);

export const workflowJobs = (envelopeId) =>
  Number(
    db(
      `select count(*) from "BackgroundJob" where "jobId" in (${WORKFLOW_JOBS.map((job) => `'${job}'`).join(', ')}) and payload->>'envelopeId' = '${envelopeId}'`,
    ),
  );

// Imagem com as ferramentas do poppler (scripts/revalle/tests/poppler.Dockerfile). Construída uma vez, se faltar:
// antes cada chamada rodava `apk add` num alpine, o que falhava de vez em quando por rede ou disco.
const POPPLER_IMAGE = 'revsign-test-poppler:local';
let popplerImageReady = false;

const ensurePopplerImage = () => {
  if (popplerImageReady) {
    return;
  }

  try {
    execFileSync('docker', ['image', 'inspect', POPPLER_IMAGE], { stdio: 'ignore' });
  } catch {
    // Dockerfile pela entrada padrão: sem enviar a pasta de testes como contexto.
    execFileSync('docker', ['build', '-q', '-t', POPPLER_IMAGE, '-'], {
      input: readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'poppler.Dockerfile')),
      stdio: ['pipe', 'ignore', 'inherit'],
    });
  }

  popplerImageReady = true;
};

// Roda ferramentas do poppler (pdftotext, pdfinfo, pdfimages...) num container com `dir` montado em /pdf.
export const poppler = (dir, script) => {
  ensurePopplerImage();

  return execFileSync('docker', ['run', '--rm', '-v', `${dir}:/pdf:ro`, POPPLER_IMAGE, 'sh', '-c', script], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
};

// Imagem do navegador (a mesma do `mobile-check`). O WSL não abre o Chromium.
export const PLAYWRIGHT_IMAGE = process.env.MOBILE_CHECK_IMAGE ?? 'mcr.microsoft.com/playwright:v1.56.1-noble';

export const hasPlaywrightImage = () =>
  spawnSync('docker', ['image', 'inspect', PLAYWRIGHT_IMAGE], { stdio: 'ignore' }).status === 0;

// Roda um script de `tests/browser/` na imagem do Playwright. `payload` (com as sessões) vai pelo ambiente, para não
// aparecer na linha de comando. `shotDir` (pasta já criada) recebe os prints. Devolve { status, stdout, stderr }.
// Assíncrono de propósito: um `spawnSync` longo trava o processo, o `fetch` não vê o app fechar a conexão ociosa e o
// próximo POST cai nesse socket morto ("other side closed").
export const runBrowserScript = ({ script, payload, shotDir, timeout = 300_000 }) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'host',
        '--ipc',
        'host',
        '-u',
        `${process.getuid()}:${process.getgid()}`,
        '-e',
        'HOME=/tmp',
        '-e',
        'BROWSER_PAYLOAD',
        ...(shotDir ? ['-e', 'SHOT_DIR=/shots', '-v', `${path.resolve(shotDir)}:/shots`] : []),
        '-v',
        `${path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')}:/repo:ro`,
        '-w',
        '/repo',
        PLAYWRIGHT_IMAGE,
        'node',
        `scripts/revalle/tests/browser/${script}`,
      ],
      {
        env: { ...process.env, BROWSER_PAYLOAD: JSON.stringify(payload) },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      },
    );
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

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

// ---------------------------------------------------------------------------------------------------------------
// Guarda contra chamadas pagas ao Gemini (Fase 5). As suítes de nota fiscal e o aceite da Fase 5 criam NFs, e cada NF
// pede uma sugestão: com uma chave de verdade no app e o endereço do Google, isso custa dinheiro. Só seguem quando o
// app aponta para o servidor falso (compose.test.yml) ou quando não tem chave. A perna real opcional
// (REVALLE_TEST_GEMINI_API_KEY) passa pelo proxy do servidor falso, então também exige o compose.test.yml.
// ---------------------------------------------------------------------------------------------------------------

export const APP_CONTAINER = 'revsign-hml-documenso-1';
export const FAKE_GEMINI_BASE_URL = 'http://fake-gemini:8787/v1beta';

// Log do app até agora, stdout e stderr juntos. Para ler só o que veio depois de um ponto, guarde `.length` e use `slice`:
// `docker logs --since` compara com a data de cada linha, e um salto do relógio deixa linhas novas de fora.
export const appLogs = () =>
  execFileSync('sh', ['-c', `docker logs ${APP_CONTAINER} 2>&1`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

// Variável de ambiente do container do app ('' quando não existe). Nunca imprima o valor de uma chave.
export const appContainerEnv = (name) =>
  execFileSync('docker', ['exec', APP_CONTAINER, 'sh', '-c', `printf %s "$${name}"`], { encoding: 'utf8' });

// Puro: a mensagem de parada, ou null quando pode seguir. Nunca inclui a chave.
// REVALLE_TEST_GEMINI_API_KEY não afrouxa esta guarda: a perna real passa pelo proxy do servidor falso.
export const paidGeminiGuardMessage = ({ apiKey, baseUrl }) => {
  if (!apiKey?.trim() || baseUrl?.trim() === FAKE_GEMINI_BASE_URL) {
    return null;
  }

  return [
    'Parado: o app tem GEMINI_API_KEY e não aponta para o servidor falso',
    `(NEXT_PRIVATE_REVALLE_GEMINI_BASE_URL = "${baseUrl?.trim() ?? ''}", esperado "${FAKE_GEMINI_BASE_URL}").`,
    'Estes testes criariam notas fiscais e chamariam o Gemini de verdade (pago).',
    'Suba a stack com compose.test.yml (servidor falso) ou sem a chave; para chamar o Gemini de propósito, defina',
    'REVALLE_TEST_GEMINI_API_KEY. Ver revalle/docs/testes.md.',
  ].join(' ');
};

// Chamada no topo de cada suíte que cria NFs: lança (e a suíte inteira para) antes de qualquer documento.
export const assertNoPaidGeminiCalls = () => {
  const message = paidGeminiGuardMessage({
    apiKey: appContainerEnv('GEMINI_API_KEY'),
    baseUrl: appContainerEnv('NEXT_PRIVATE_REVALLE_GEMINI_BASE_URL'),
  });

  if (message) {
    throw new Error(message);
  }
};
