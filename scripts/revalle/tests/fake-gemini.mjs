// Servidor FALSO do Gemini para os testes do RevSign (Fase 5). Node puro, sem dependências.
//
// Por que existe: a sugestão de conta chama uma API externa e paga (Google Gemini). Os testes de integração não
// usam mock dentro do app; este servidor fica na FRONTEIRA DE REDE, no lugar do Google, e responde no mesmo formato
// da API `generateContent`. O app não sabe que é falso: só muda `NEXT_PRIVATE_REVALLE_GEMINI_BASE_URL`.
// Ver revalle/docs/testes.md ("Servidor falso do Gemini").
//
// Rotas:
//   POST /v1beta/models/{modelo}:generateContent   resposta no formato do Gemini, conforme o modo programado
//   POST /__program { mode, accountCode?, delayMs?, apiKey? }
//        modos: ok | unknown-account | garbage | slow (25 s) | error (HTTP 500) | proxy (repassa ao Gemini de verdade
//        com `apiKey`; perna opcional dos testes, chave só na memória, nunca devolvida nem registrada)
//   GET  /__calls                                    chamadas recebidas (modelo, se veio PDF ou texto, tamanhos)
//   POST /__reset                                    apaga as chamadas e volta ao modo ok
//
// Uso: node scripts/revalle/tests/fake-gemini.mjs   (porta: FAKE_GEMINI_PORT, padrão 8787)
// Chave esperada no cabeçalho x-goog-api-key: FAKE_GEMINI_API_KEY (padrão test-key); outra chave recebe 403.

import { createServer } from 'node:http';

const PORT = Number(process.env.FAKE_GEMINI_PORT ?? 8787);
const API_KEY = process.env.FAKE_GEMINI_API_KEY ?? 'test-key';
const MODES = new Set(['ok', 'unknown-account', 'garbage', 'slow', 'error', 'proxy']);
const REAL_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GENERATE_PATH = /^\/v1beta\/models\/([^/:]+):generateContent$/;

const initialProgram = () => ({ mode: 'ok', accountCode: null, delayMs: 25_000, apiKey: null });
const publicProgram = () => ({ ...program, apiKey: program.apiKey ? '(definida)' : null });

let program = initialProgram();
let calls = [];

const sendJson = (res, status, body) => {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const textOf = (content) =>
  (content?.parts ?? [])
    .map((part) => part.text ?? '')
    .filter(Boolean)
    .join('\n');

// Primeiro código da lista de contas que o app manda nas instruções ("- 2.1.03 — Fornecedores ...").
const firstAccountCode = (system) => /^- (\S+) — /m.exec(system)?.[1] ?? null;

const describeParts = (contents) =>
  (contents ?? []).flatMap((content) =>
    (content.parts ?? []).map((part) => {
      if (part.inlineData) {
        return {
          role: content.role,
          type: 'file',
          mimeType: part.inlineData.mimeType,
          size: Buffer.from(part.inlineData.data ?? '', 'base64').length,
        };
      }

      return { role: content.role, type: 'text', length: (part.text ?? '').length, text: part.text ?? '' };
    }),
  );

const geminiResponse = (model, text) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 42, totalTokenCount: 363 },
  modelVersion: model,
  responseId: `fake-${calls.length}`,
});

const handleGenerate = async (req, res, model) => {
  const raw = await readBody(req);
  let body;

  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: { code: 400, message: 'JSON inválido', status: 'INVALID_ARGUMENT' } });

    return;
  }

  const system = textOf(body.systemInstruction);
  const parts = describeParts(body.contents);
  const files = parts.filter((part) => part.type === 'file');
  // A 1ª parte de texto do usuário é a linha fixa do app ("O conteúdo a seguir é o documento..."); o texto do
  // documento, quando há, vem nas seguintes.
  const texts = parts.filter((part) => part.type === 'text').slice(1);
  const call = {
    at: new Date().toISOString(),
    model,
    authorized: req.headers['x-goog-api-key'] === API_KEY,
    mode: program.mode,
    hasPdf: files.some((part) => part.mimeType === 'application/pdf'),
    hasText: texts.some((part) => part.length > 0),
    textLength: texts.reduce((total, part) => total + part.length, 0),
    pdfSize: files.reduce((total, part) => total + part.size, 0),
    system,
    parts,
    responseMimeType: body.generationConfig?.responseMimeType ?? null,
    hasResponseSchema: Boolean(body.generationConfig?.responseSchema),
  };

  calls.push(call);

  if (!call.authorized) {
    sendJson(res, 403, { error: { code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' } });

    return;
  }

  const accountCode = program.accountCode ?? firstAccountCode(system) ?? '0';

  switch (program.mode) {
    case 'ok':
      sendJson(
        res,
        200,
        geminiResponse(
          model,
          JSON.stringify({ accountCode, confidence: 'alta', reason: 'Compra de mercadoria de fornecedor (falso).' }),
        ),
      );

      return;
    case 'unknown-account':
      sendJson(
        res,
        200,
        geminiResponse(model, JSON.stringify({ accountCode: '0.0.NAO-EXISTE', confidence: 'media', reason: 'x' })),
      );

      return;
    case 'garbage':
      sendJson(res, 200, geminiResponse(model, 'isto não é JSON {{{'));

      return;
    case 'error':
      sendJson(res, 500, { error: { code: 500, message: 'Erro interno (falso)', status: 'INTERNAL' } });

      return;
    case 'proxy': {
      // Perna opcional "Gemini de verdade": repassa a chamada ao Google com a chave do teste.
      const upstream = await fetch(`${REAL_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': program.apiKey ?? '' },
        body: raw,
      });

      call.upstreamStatus = upstream.status;
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(await upstream.text());

      return;
    }
    case 'slow': {
      const timer = setTimeout(() => {
        sendJson(
          res,
          200,
          geminiResponse(model, JSON.stringify({ accountCode, confidence: 'baixa', reason: 'Resposta lenta.' })),
        );
      }, program.delayMs);

      // O app desiste antes (20 s): não segura o timer depois que a conexão cai.
      res.on('close', () => clearTimeout(timer));

      return;
    }
    default:
      sendJson(res, 500, { error: { code: 500, message: 'modo desconhecido' } });
  }
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  try {
    if (req.method === 'GET' && url.pathname === '/__calls') {
      sendJson(res, 200, calls);

      return;
    }

    if (req.method === 'POST' && url.pathname === '/__reset') {
      await readBody(req);
      program = initialProgram();
      calls = [];
      sendJson(res, 200, { ok: true });

      return;
    }

    if (req.method === 'POST' && url.pathname === '/__program') {
      const input = JSON.parse((await readBody(req)) || '{}');

      if (!MODES.has(input.mode)) {
        sendJson(res, 400, { error: `modo inválido: ${input.mode}` });

        return;
      }

      program = {
        mode: input.mode,
        accountCode: input.accountCode ?? null,
        delayMs: Number(input.delayMs ?? 25_000),
        apiKey: input.mode === 'proxy' ? (input.apiKey ?? null) : null,
      };
      sendJson(res, 200, publicProgram());

      return;
    }

    if (req.method === 'GET' && url.pathname === '/__health') {
      sendJson(res, 200, { ok: true });

      return;
    }

    const match = req.method === 'POST' ? GENERATE_PATH.exec(url.pathname) : null;

    if (match) {
      await handleGenerate(req, res, decodeURIComponent(match[1]));

      return;
    }

    sendJson(res, 404, { error: { code: 404, message: `rota não encontrada: ${req.method} ${url.pathname}` } });
  } catch (error) {
    sendJson(res, 500, { error: { code: 500, message: String(error?.message ?? error) } });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`fake-gemini ouvindo na porta ${PORT}`);
});

const stop = () => server.close(() => process.exit(0));

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
