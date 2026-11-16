// Integração Patrimônio → RevSign (termos de responsabilidade de equipamento). Contrato: revalle/docs/patrimonio.md.
// Roda com a stack subida com compose.test.yml (chave, conta remetente e webhook de teste). Os avisos chegam a um
// receptor que este teste sobe na máquina (porta 8799), alcançado pelo app em host.docker.internal.
// O último teste recria o app sem a chave (integração desligada) e o recria de novo como estava.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import './account-autologin.mjs'; // conta obrigatória (16/11/2026): entra na conta de quem assina pelo e-mail da empresa
import {
  APP_CONTAINER,
  api,
  appContainerEnv,
  assertNoPaidGeminiCalls,
  BASE_URL,
  chooseInvoice,
  completeWithCode,
  createEnvelope,
  danfePdfFile,
  db,
  ensureInvoiceAccounts,
  fetchIdempotent,
  isStaleSocketError,
  mailIdsTo,
  signIn,
  trpc,
  trpcAs,
  waitNewMail,
} from './helpers.mjs';

const API = `${BASE_URL}/api/revalle/patrimonio/v1`;
const KEY = 'test-only-patrimonio-api-key-not-a-secret';
const SECRET = 'test-only-patrimonio-webhook-secret';
const HOOK_PORT = 8799;

// Pessoas fictícias de revalle/colaboradores/dev-seed.sql. João tem e-mail da empresa na base (que o termo ignora).
const JOAO = { cpf: '52871936455', birthDate: '20/11/1985' };
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
// CPF válido que não está na base.
const OUTSIDER_CPF = '12345678909';
const LINKED_ELSEWHERE_EMAIL = 'patrimonio-vinculo-joao@revalle.com.br';
const LOCKED_MESSAGE = /Este termo é do Patrimônio/;
const DELETE_MESSAGE = /Este termo é do Patrimônio: cancele pelo sistema do Patrimônio\./;

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const external = (tag) => `pat-${tag}-${RUN}@gmail.com`;
const extId = (tag) => `PAT-${tag}-${RUN}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------------------------------------------
// PDF mínimo (uma página A4, Helvetica) com as linhas dadas. Sem dependências.
// ---------------------------------------------------------------------------------------------------------------
// `page` muda o dicionário da página (ex.: '/Rotate 90' ou '/MediaBox [10 10 605 852]').
const makePdf = (lines, { page = '/MediaBox [0 0 595 842]' } = {}) => {
  const escapePdfText = (text) => text.replace(/[\\()]/g, (char) => `\\${char}`);
  const content = lines
    .map((line, i) => `BT /F1 12 Tf 72 ${760 - i * 28} Td (${escapePdfText(line)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R ${page.includes('/MediaBox') ? page : `/MediaBox [0 0 595 842] ${page}`} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];

  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = Buffer.byteLength(pdf, 'latin1');

  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
};

const TERMO_PDF = makePdf([
  'TERMO DE RESPONSABILIDADE DE EQUIPAMENTO',
  'Equipamento: Notebook de teste, patrimonio 000123',
  'Declaro que recebi o equipamento acima em perfeito estado.',
  '',
  'Assinatura do colaborador: {{ Assinatura }}',
]);

// ---------------------------------------------------------------------------------------------------------------
// Receptor dos avisos: confere o HMAC de cada um e guarda o que chegou. `failNext` faz a próxima entrega de um evento
// responder 500 (para conferir a nova tentativa), pela chave `${externalId}|${event}`.
// ---------------------------------------------------------------------------------------------------------------
const received = [];
const failNext = new Set();
let server;

const verifySignature = (headers, rawBody) => {
  const timestamp = headers['x-revsign-timestamp'];
  const signature = headers['x-revsign-signature'] ?? '';
  const expected = `sha256=${createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  // O relógio do WSL volta ~10 s de vez em quando: tolerância larga, só para pegar timestamp absurdo.
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;

  return (
    fresh && expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  );
};

const startReceiver = () =>
  new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const chunks = [];

      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let body;

        try {
          body = JSON.parse(rawBody);
        } catch {
          body = null;
        }

        const failKey = body ? `${body.externalId}|${body.event}` : '';
        const shouldFail = failNext.has(failKey);

        received.push({
          path: req.url,
          headers: req.headers,
          rawBody,
          body,
          verified: verifySignature(req.headers, rawBody),
          answered: shouldFail ? 500 : 200,
        });

        if (shouldFail) {
          failNext.delete(failKey);
          res.writeHead(500).end('falha de teste');

          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      });
    });
    server.on('error', reject);
    server.listen(HOOK_PORT, '0.0.0.0', resolve);
  });

const waitEvent = async (termoId, event, { timeoutMs = 60_000, count = 1 } = {}) => {
  const deadline = performance.now() + timeoutMs;

  do {
    const hits = received.filter((hit) => hit.body?.termoId === termoId && hit.body?.event === event);

    if (hits.length >= count) {
      return hits;
    }

    await sleep(250);
  } while (performance.now() < deadline);

  throw new Error(`aviso ${event} de ${termoId} não chegou em ${timeoutMs / 1000} s`);
};

// ---------------------------------------------------------------------------------------------------------------
// Chamadas à API da integração.
// ---------------------------------------------------------------------------------------------------------------
const auth = (key = KEY) => (key === null ? {} : { Authorization: `Bearer ${key}` });

const readJson = async (res) => {
  const text = await res.text();
  let body;

  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }

  return { status: res.status, headers: res.headers, body, text };
};

const get = (route, { key } = {}) => fetchIdempotent(`${API}${route}`, { headers: auth(key) }, readJson);

const post = async (route, body, { key } = {}) =>
  readJson(
    await fetch(`${API}${route}`, {
      method: 'POST',
      headers: { ...auth(key), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const termoForm = ({ file = TERMO_PDF, fileName = 'termo.pdf', ...overrides } = {}) => {
  const fields = {
    externalId: extId('x'),
    kind: 'ENTREGA',
    title: `[TESTE] Termo Patrimônio ${RUN}`,
    signerName: 'João Exemplo Pereira',
    signerEmail: external('x'),
    signerCpf: JOAO.cpf,
    ...overrides,
  };
  const form = new FormData();

  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) {
      form.append(name, value);
    }
  }

  if (file !== null) {
    form.append('file', new File([file], fileName, { type: 'application/pdf' }));
  }

  return form;
};

// POST da criação. Em socket velho repete uma vez; se o primeiro já tinha criado, a repetição dá 409 com o termoId
// (a criação é segura para repetir por causa do externalId), e o termo é lido por ele.
const createTermo = async (overrides = {}, { key } = {}) => {
  const once = async () =>
    readJson(await fetch(`${API}/termos`, { method: 'POST', headers: auth(key), body: termoForm(overrides) }));

  try {
    return await once();
  } catch (error) {
    if (!isStaleSocketError(error)) {
      throw error;
    }

    const retried = await once();

    if (retried.status === 409 && retried.body?.error?.termoId) {
      const existing = await get(`/termos/${retried.body.error.termoId}`);

      return { ...existing, status: 201 };
    }

    return retried;
  }
};

const assertError = (res, status, code) => {
  assert.equal(res.status, status, res.text);
  assert.equal(res.body?.error?.code, code, res.text);
  assert.equal(typeof res.body?.error?.message, 'string');
};

// Dados do destinatário do termo (token, documentId, campo de assinatura), lidos do banco.
const signerOf = (termoId) => {
  const [recipientId, token, email] = db(
    `select id || '|' || token || '|' || email from "Recipient" where "envelopeId" = '${termoId}'`,
  ).split('|');
  const secondaryId = db(`select "secondaryId" from "Envelope" where id = '${termoId}'`);
  const fieldIds = db(`select id from "Field" where "envelopeId" = '${termoId}' and type = 'SIGNATURE' order by id`)
    .split('\n')
    .filter(Boolean)
    .map(Number);

  return {
    recipientId: Number(recipientId),
    token,
    email,
    documentId: Number.parseInt(secondaryId.split('_')[1], 10),
    fieldIds,
  };
};

const gate = async (procedure, input) => {
  const res = await trpc(`revalle.gate.${procedure}`, input);

  return { ...res, state: res.body?.result?.data?.json };
};

const passGate = async (token, person) => {
  const accepted = await gate('acceptTerm', { token, termVersion: '1' });

  assert.equal(accepted.state?.status, 'IDENTITY_REQUIRED', accepted.text);

  const verified = await gate('verifyIdentity', { token, cpf: person.cpf, birthDate: person.birthDate });

  assert.equal(verified.state?.status, 'IDENTITY_CONFIRM', verified.text);

  const confirmed = await gate('confirmIdentity', { token, isMe: true });

  assert.equal(confirmed.state?.status, 'PASSED', confirmed.text);
};

const signFields = async (signer) => {
  for (const fieldId of signer.fieldIds) {
    const signed = await trpc('envelope.field.sign', {
      token: signer.token,
      fieldId,
      fieldValue: { type: 'SIGNATURE', value: 'Joao Exemplo' },
    });

    assert.equal(signed.status, 200, signed.text);
  }
};

const waitTermoStatus = async (termoId, status, timeoutMs = 120_000) => {
  const deadline = performance.now() + timeoutMs;
  let last;

  do {
    last = await get(`/termos/${termoId}`);

    if (last.body?.status === status) {
      return last;
    }

    await sleep(2000);
  } while (performance.now() < deadline);

  throw new Error(`termo ${termoId} não chegou a ${status} (último: ${last?.text})`);
};

const cleanupLinks = () => {
  db(`delete from "RevalleEmailLink" where cpf in ('${JOAO.cpf}', '${MARIA.cpf}')`);
  db(`delete from "RevalleEmailLink" where email like 'pat-%-${RUN}@gmail.com'`);
};

const fx = {};

before(async () => {
  if (!appContainerEnv('NEXT_PRIVATE_REVALLE_PATRIMONIO_API_KEY')) {
    throw new Error(
      'Parado: o app não tem NEXT_PRIVATE_REVALLE_PATRIMONIO_API_KEY. Suba a stack com compose.test.yml (ver testes.md).',
    );
  }

  await startReceiver();
  db('delete from "RateLimit"');
  cleanupLinks();
});

beforeEach(() => {
  db(`delete from "RateLimit" where action like 'revalle.%'`);
});

after(async () => {
  cleanupLinks();
  await new Promise((resolve) => server?.close(resolve) ?? resolve());
});

test('sem chave, chave errada ou outro esquema: 401 UNAUTHORIZED (antes de ler o corpo)', async () => {
  assertError(await get('/termos?externalId=X', { key: null }), 401, 'UNAUTHORIZED');
  assertError(await get('/termos?externalId=X', { key: `${KEY}x` }), 401, 'UNAUTHORIZED');
  assertError(await get('/termos?externalId=X', { key: 'curta' }), 401, 'UNAUTHORIZED');

  const basic = await fetchIdempotent(
    `${API}/termos?externalId=X`,
    { headers: { Authorization: `Basic ${KEY}` } },
    readJson,
  );

  assertError(basic, 401, 'UNAUTHORIZED');

  const before = Number(db(`select count(*) from "RevallePatrimonioTermo" where "externalId" = '${extId('nokey')}'`));
  const created = await createTermo({ externalId: extId('nokey') }, { key: 'errada' });

  assertError(created, 401, 'UNAUTHORIZED');
  assert.equal(
    Number(db(`select count(*) from "RevallePatrimonioTermo" where "externalId" = '${extId('nokey')}'`)),
    before,
  );
  assertError(await get('/termos/qualquer', { key: null }), 401, 'UNAUTHORIZED');
  assertError(await post('/termos/qualquer/cancelar', undefined, { key: null }), 401, 'UNAUTHORIZED');
});

test('criação com e-mail externo: 201, PENDING, convite enviado e aviso termo.sent assinado', async () => {
  const email = external('main');
  const seen = await mailIdsTo(email);
  const created = await createTermo({ externalId: extId('main'), signerEmail: email });

  assert.equal(created.status, 201, created.text);
  assert.match(created.body.termoId, /^envelope_/);
  assert.equal(created.body.status, 'PENDING');
  assert.equal(created.body.externalId, extId('main'));
  assert.equal(created.body.kind, 'ENTREGA');
  assert.equal(created.body.signer.email, email);
  assert.ok(!created.text.includes(JOAO.cpf), 'CPF na resposta');

  const termoId = created.body.termoId;

  fx.main = termoId;

  // O aviso vai a um nome interno de uma parte só, por http, sem a liberação global de SSRF.
  assert.equal(appContainerEnv('NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS'), '');
  assert.match(appContainerEnv('NEXT_PRIVATE_REVALLE_PATRIMONIO_WEBHOOK_URL'), /^http:\/\/patrimonio-hook:/);

  // Envelope do Documenso, dono = conta remetente, destinatário externo, um campo de assinatura do marcador.
  assert.equal(db(`select status from "Envelope" where id = '${termoId}'`), 'PENDING');
  assert.equal(
    db(`select u.email from "Envelope" e join "User" u on u.id = e."userId" where e.id = '${termoId}'`),
    'admin@hml.local',
  );
  assert.equal(db(`select email from "Recipient" where "envelopeId" = '${termoId}'`), email);
  assert.equal(db(`select "signerCpf" from "RevallePatrimonioTermo" where "envelopeId" = '${termoId}'`), JOAO.cpf);

  const field = db(
    `select page || '|' || "positionX" || '|' || "positionY" || '|' || width || '|' || height from "Field" where "envelopeId" = '${termoId}'`,
  ).split('|');

  assert.equal(field[0], '1');
  // 180 × 54 pt numa página de 595 × 842 pt, com o canto no início do marcador: 5ª linha, depois do rótulo
  // "Assinatura do colaborador: " (72 pt de margem + ~147 pt do rótulo em Helvetica 12).
  assert.ok(Math.abs((Number(field[1]) * 595) / 100 - 219) < 6, `positionX ${field[1]}`);
  assert.ok(Math.abs(Number(field[3]) - (180 / 595) * 100) < 0.1, `width ${field[3]}`);
  assert.ok(Math.abs(Number(field[4]) - (54 / 842) * 100) < 0.1, `height ${field[4]}`);
  assert.ok(Number(field[2]) > 10 && Number(field[2]) < 25, `positionY ${field[2]}`);

  const invite = await waitNewMail(email, seen, { what: 'Convite do termo' });

  assert.match(invite.Text ?? '', /\/sign\//);

  const [sent] = await waitEvent(termoId, 'termo.sent');

  assert.equal(sent.path, '/hook');
  assert.ok(sent.verified, 'HMAC do aviso não confere');
  assert.equal(sent.headers['content-type'], 'application/json');
  assert.match(sent.body.eventId, /^evt_/);
  assert.equal(sent.headers['x-revsign-event-id'], sent.body.eventId);
  assert.deepEqual(Object.keys(sent.body), [
    'eventId',
    'event',
    'termoId',
    'externalId',
    'status',
    'occurredAt',
    'signer',
  ]);
  assert.deepEqual(sent.body.signer, { name: 'João Exemplo Pereira', email });
  assert.equal(sent.body.status, 'PENDING');
  assert.equal(sent.body.externalId, extId('main'));
  assert.ok(!sent.rawBody.includes(JOAO.cpf), 'CPF no aviso');
  assert.ok(!/token/i.test(sent.rawBody), 'token no aviso');

  const status = await get(`/termos/${termoId}`);

  assert.equal(status.status, 200, status.text);
  assert.equal(status.body.status, 'PENDING');
});

// Desde 16/11/2026 (e-mail externo), o mesmo e-mail pessoal vale num documento comum, pela API e pela tela; a nota fiscal
// continua só para e-mails da empresa.
test('o mesmo e-mail externo vale num documento comum (API e tela); numa nota fiscal, o envio é recusado', async () => {
  const email = external('main');
  const viaApi = await createEnvelope({ recipients: [{ email }] });

  assert.equal(viaApi.status, 200, viaApi.text);

  const userEmail = process.env.REVSIGN_USER_EMAIL;
  const userPassword = process.env.REVSIGN_USER_PASSWORD;
  const adminEmail = process.env.REVSIGN_ADMIN_EMAIL;
  const adminPassword = process.env.REVSIGN_ADMIN_PASSWORD;

  assert.ok(userEmail && userPassword, 'defina REVSIGN_USER_EMAIL e REVSIGN_USER_PASSWORD');
  assert.ok(adminEmail && adminPassword, 'defina REVSIGN_ADMIN_EMAIL e REVSIGN_ADMIN_PASSWORD');

  const draft = await createEnvelope({ recipients: [{ email: `pat-tela-${RUN}@revalle.com.br` }] });

  assert.equal(draft.status, 200, draft.text);

  const cookie = await signIn(userEmail, userPassword);
  const teamId = db(`select "teamId" from "Envelope" where id = '${draft.id}'`);
  const viaScreen = await trpcAs(
    cookie,
    'mutation',
    'envelope.recipient.set',
    {
      envelopeId: draft.id,
      envelopeType: 'DOCUMENT',
      recipients: [{ email, name: 'Externo', role: 'SIGNER' }],
    },
    { 'x-team-id': teamId },
  );

  assert.equal(viaScreen.ok, true, viaScreen.text);
  assert.equal(db(`select count(*) from "Recipient" where email = '${email}' and "envelopeId" = '${draft.id}'`), '1');

  // Nota fiscal para o mesmo e-mail: o rascunho é criado, a conta e o centro são escolhidos, e o envio é recusado.
  // Antes de criar a NF, confere que o app não pode chamar o Gemini pago.
  assertNoPaidGeminiCalls();
  await ensureInvoiceAccounts(await signIn(adminEmail, adminPassword));

  const invoice = await createEnvelope({ recipients: [{ email }], pdf: danfePdfFile(`pat-${RUN}`) });

  assert.equal(invoice.status, 200, invoice.text);
  assert.equal((await chooseInvoice({ cookie, envelopeId: invoice.id })).status, 200);

  const sent = await api('POST', '/envelope/distribute', { envelopeId: invoice.id });

  assert.equal(sent.status, 400, sent.text);
  assert.ok(sent.text.includes(`Troque o e-mail de ${email}.`), sent.text);
  assert.equal(db(`select status from "Envelope" where id = '${invoice.id}'`), 'DRAFT');
});

test('PDF antes de assinar: 409 NOT_SIGNED; termo inexistente: 404 NOT_FOUND', async () => {
  assertError(await get(`/termos/${fx.main}/pdf`), 409, 'NOT_SIGNED');
  assertError(await get('/termos/envelope_naoexiste'), 404, 'NOT_FOUND');
  assertError(await get('/termos/envelope_naoexiste/pdf'), 404, 'NOT_FOUND');
  assertError(await post('/termos/envelope_naoexiste/cancelar'), 404, 'NOT_FOUND');
});

test('pedido inválido: marcador ausente, arquivo que não é PDF, arquivo grande, campos e CPF', async () => {
  const count = (id) => Number(db(`select count(*) from "Envelope" where "externalId" = '${id}'`));

  const noMarker = await createTermo({
    externalId: extId('nomarker'),
    file: makePdf(['Termo sem lugar de assinatura', 'Assinatura: ____________']),
  });

  assertError(noMarker, 422, 'MARKER_NOT_FOUND');
  assert.equal(count(extId('nomarker')), 0, 'rascunho ficou para trás');

  const docx = await createTermo({
    externalId: extId('docx'),
    file: Buffer.from('PK\u0003\u0004 isto seria um docx'),
    fileName: 'termo.docx',
  });

  assertError(docx, 422, 'INVALID_FILE');

  const broken = await createTermo({ externalId: extId('broken'), file: Buffer.from('%PDF-1.4\nlixo sem estrutura') });

  assertError(broken, 422, 'INVALID_FILE');

  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x20);

  big.write('%PDF-1.4\n');
  assertError(await createTermo({ externalId: extId('big'), file: big }), 413, 'FILE_TOO_LARGE');

  const marker = ['Termo', 'Assinatura: {{assinatura}}'];

  for (const [tag, page] of [
    ['rot', '/Rotate 90'],
    ['box', '/MediaBox [10 10 605 852]'],
  ]) {
    const res = await createTermo({ externalId: extId(tag), file: makePdf(marker, { page }) });

    assertError(res, 422, 'INVALID_FILE');
    assert.match(res.body.error.message, /página 1.*girada/, res.text);
    assert.equal(count(extId(tag)), 0, `envelope criado para ${tag}`);
  }

  assertError(await createTermo({ externalId: 'com espaço' }), 400, 'INVALID_REQUEST');
  assertError(await createTermo({ externalId: extId('kind'), kind: 'EMPRESTIMO' }), 400, 'INVALID_REQUEST');
  assertError(await createTermo({ externalId: extId('mail'), signerEmail: 'sem-arroba' }), 400, 'INVALID_REQUEST');
  assertError(await createTermo({ externalId: extId('nofile'), file: null }), 400, 'INVALID_REQUEST');

  const json = await readJson(
    await fetch(`${API}/termos`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );

  assertError(json, 400, 'INVALID_REQUEST');

  assertError(await createTermo({ externalId: extId('cpf'), signerCpf: '123.456.789-00' }), 422, 'INVALID_CPF');
  assertError(
    await createTermo({ externalId: extId('outsider'), signerCpf: OUTSIDER_CPF }),
    422,
    'COLABORADOR_NOT_FOUND',
  );

  for (const id of ['docx', 'broken', 'big', 'cpf', 'outsider']) {
    assert.equal(count(extId(id)), 0, `envelope criado para ${id}`);
  }

  assertError(await get('/termos'), 400, 'INVALID_REQUEST');
  assertError(await get('/termos?externalId=com%20espa%C3%A7o'), 400, 'INVALID_REQUEST');
});

test('externalId duplicado (pendente): 409 com o termoId existente; busca pelo externalId', async () => {
  const dup = await createTermo({ externalId: extId('main'), signerEmail: external('dup') });

  assertError(dup, 409, 'DUPLICATE_EXTERNAL_ID');
  assert.equal(dup.body.error.termoId, fx.main);

  const found = await get(`/termos?externalId=${encodeURIComponent(extId('main'))}`);

  assert.equal(found.status, 200, found.text);
  assert.deepEqual(
    found.body.data.map((termo) => termo.termoId),
    [fx.main],
  );
});

test('cancelar: só PENDING, aviso termo.cancelled; o externalId fica livre e a busca lista o mais novo primeiro', async () => {
  const id = extId('cancel');
  const first = await createTermo({ externalId: id, signerEmail: external('cancel') });

  assert.equal(first.status, 201, first.text);

  const cancelled = await post(`/termos/${first.body.termoId}/cancelar`, { reason: 'Troca de equipamento' });

  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.body.status, 'CANCELLED');
  assert.equal(cancelled.body.cancelReason, 'Troca de equipamento');
  assert.ok(cancelled.body.cancelledAt);
  assert.equal(db(`select status from "Envelope" where id = '${first.body.termoId}'`), 'CANCELLED');
  assert.ok(
    Number(
      db(
        `select count(*) from "DocumentAuditLog" where "envelopeId" = '${first.body.termoId}' and type = 'DOCUMENT_CANCELLED'`,
      ),
    ) === 1,
    'trilha de auditoria do cancelamento',
  );

  const [event] = await waitEvent(first.body.termoId, 'termo.cancelled');

  assert.ok(event.verified);
  assert.equal(event.body.status, 'CANCELLED');

  assertError(await post(`/termos/${first.body.termoId}/cancelar`), 409, 'NOT_PENDING');
  assertError(await post(`/termos/${first.body.termoId}/reenviar`), 409, 'NOT_PENDING');
  assertError(await post(`/termos/${first.body.termoId}/cancelar`, { reason: 5 }), 400, 'INVALID_REQUEST');

  // O link do signatário para de funcionar.
  const signer = signerOf(first.body.termoId);
  const accepted = await gate('acceptTerm', { token: signer.token, termVersion: '1' });
  const signed = await trpc('envelope.field.sign', {
    token: signer.token,
    fieldId: signer.fieldIds[0],
    fieldValue: { type: 'SIGNATURE', value: 'x' },
  });

  assert.notEqual(signed.status, 200, `${accepted.text} ${signed.text}`);

  const second = await createTermo({ externalId: id, signerEmail: external('cancel2') });

  assert.equal(second.status, 201, second.text);

  const found = await get(`/termos?externalId=${encodeURIComponent(id)}`);

  assert.deepEqual(
    found.body.data.map((termo) => [termo.termoId, termo.status]),
    [
      [second.body.termoId, 'PENDING'],
      [first.body.termoId, 'CANCELLED'],
    ],
  );

  fx.resend = second.body.termoId;
});

test('reenviar: manda o e-mail de novo e respeita 1 vez a cada 10 minutos', async () => {
  const email = external('cancel2');
  const seen = await mailIdsTo(email);
  const first = await post(`/termos/${fx.resend}/reenviar`);

  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.status, 'PENDING');

  const mail = await waitNewMail(email, seen, { what: 'Reenvio do termo' });

  assert.match(mail.Text ?? '', /\/sign\//);

  const tooSoon = await post(`/termos/${fx.resend}/reenviar`);

  assertError(tooSoon, 429, 'RESEND_TOO_SOON');
  assert.ok(Number(tooSoon.headers.get('retry-after')) > 500, tooSoon.headers.get('retry-after'));

  db(
    `update "RevallePatrimonioTermo" set "lastResendAt" = now() - interval '11 minutes' where "envelopeId" = '${fx.resend}'`,
  );

  const seenAgain = await mailIdsTo(email);
  const again = await post(`/termos/${fx.resend}/reenviar`);

  assert.equal(again.status, 200, again.text);
  await waitNewMail(email, seenAgain, { what: 'Segundo reenvio do termo' });

  assert.equal((await post(`/termos/${fx.resend}/cancelar`)).status, 200);
});

test('chave primeiro: lixo com X-Forwarded-For forjado não tira o limite do Patrimônio', async () => {
  const spoofed = { 'X-Forwarded-For': '198.51.100.77' };
  let limited = 0;

  for (let i = 0; i < 25; i += 1) {
    const res = await fetchIdempotent(
      `${API}/termos?externalId=X`,
      { headers: { Authorization: 'Bearer chave-errada', ...spoofed } },
      readJson,
    );

    assert.ok([401, 429].includes(res.status), res.text);
    limited += res.status === 429 ? 1 : 0;
  }

  assert.ok(limited > 0, 'o balde de falhas não limitou');

  const ok = await fetchIdempotent(
    `${API}/termos?externalId=${encodeURIComponent(extId('main'))}`,
    { headers: { ...auth(), ...spoofed } },
    readJson,
  );

  assert.equal(ok.status, 200, ok.text);
  assert.equal(
    db(`select count(*) from "RateLimit" where action = 'revalle.patrimonio' and key = 'ip:patrimonio-key'`) !== '0',
    true,
  );
});

test('termo do Patrimônio não é excluído, reenviado, alterado nem duplicado pela tela, pela API comum ou pelo admin', async () => {
  const adminEmail = process.env.REVSIGN_ADMIN_EMAIL;
  const adminPassword = process.env.REVSIGN_ADMIN_PASSWORD;
  const userEmail = process.env.REVSIGN_USER_EMAIL;
  const userPassword = process.env.REVSIGN_USER_PASSWORD;

  assert.ok(adminEmail && adminPassword && userEmail && userPassword, 'defina REVSIGN_ADMIN_* e REVSIGN_USER_*');

  const email = external('locked');
  const created = await createTermo({ externalId: extId('locked'), signerEmail: email });

  assert.equal(created.status, 201, created.text);

  const termoId = created.body.termoId;
  const signer = signerOf(termoId);
  const teamId = db(`select "teamId" from "Envelope" where id = '${termoId}'`);
  const seen = await mailIdsTo(email);
  const userCookie = await signIn(userEmail, userPassword);
  const adminCookie = await signIn(adminEmail, adminPassword);
  const expect = (res, pattern, what) => {
    assert.notEqual(res.status, 200, `${what}: ${res.text}`);
    assert.match(res.text, pattern, what);
  };

  expect(await api('POST', '/envelope/delete', { envelopeId: termoId }), DELETE_MESSAGE, 'API v2 delete');

  const v1 = await readJson(
    await fetch(`${BASE_URL}/api/v1/documents/${signer.documentId}`, {
      method: 'DELETE',
      headers: { Authorization: process.env.REVSIGN_API_TOKEN },
    }),
  );

  // A API v1 não enxerga documento v2 (o termo é v2) e responde 404 antes; a guarda está em `deleteDocument`, que a v1
  // também usa.
  assert.notEqual(v1.status, 200, v1.text);

  const bulk = await trpcAs(
    userCookie,
    'mutation',
    'envelope.bulk.delete',
    { envelopeIds: [termoId] },
    {
      'x-team-id': teamId,
    },
  );

  // A exclusão em lote não lança: o termo sai como falha e continua (conferido no banco no fim).
  assert.ok(bulk.status < 500, bulk.text);

  expect(
    await trpcAs(adminCookie, 'mutation', 'admin.document.delete', { id: termoId, reason: 'teste' }),
    DELETE_MESSAGE,
    'admin delete',
  );
  expect(
    await api('POST', '/envelope/redistribute', { envelopeId: termoId, recipients: [signer.recipientId] }),
    LOCKED_MESSAGE,
    'redistribute',
  );
  expect(await api('POST', '/envelope/distribute', { envelopeId: termoId }), LOCKED_MESSAGE, 'distribute');
  expect(
    await api('POST', '/envelope/recipient/update-many', {
      envelopeId: termoId,
      data: [{ id: signer.recipientId, name: 'Outro nome' }],
    }),
    LOCKED_MESSAGE,
    'recipient update',
  );
  expect(await api('POST', '/envelope/duplicate', { envelopeId: termoId }), LOCKED_MESSAGE, 'duplicate');

  // Nada mudou: termo pendente, envelope não excluído, nome igual, nenhum e-mail novo ao colaborador.
  assert.equal(
    db(`select status || '|' || ("deletedAt" is null) from "Envelope" where id = '${termoId}'`),
    'PENDING|true',
  );
  assert.equal(db(`select name from "Recipient" where id = ${signer.recipientId}`), 'João Exemplo Pereira');
  assert.equal(db(`select count(*) from "RevallePatrimonioTermo" where "envelopeId" = '${termoId}'`), '1');
  assert.equal((await get(`/termos/${termoId}`)).body.status, 'PENDING');
  await sleep(1500);
  assert.deepEqual(
    [...(await mailIdsTo(email))].filter((id) => !seen.has(id)),
    [],
  );

  // Cancelar pela tela continua possível e avisa o Patrimônio.
  fx.locked = termoId;
});

test('vencido continua vencido: o reenvio pela API comum é recusado e o da integração dá NOT_PENDING', async () => {
  const created = await createTermo({ externalId: extId('expired'), signerEmail: external('expired') });

  assert.equal(created.status, 201, created.text);

  const termoId = created.body.termoId;
  const signer = signerOf(termoId);

  db(`update "Recipient" set "expiresAt" = now() - interval '1 minute' where id = ${signer.recipientId}`);

  const expiresAt = db(`select "expiresAt" from "Recipient" where id = ${signer.recipientId}`);

  assert.equal((await get(`/termos/${termoId}`)).body.status, 'EXPIRED');

  const redistributed = await api('POST', '/envelope/redistribute', {
    envelopeId: termoId,
    recipients: [signer.recipientId],
  });

  assert.notEqual(redistributed.status, 200, redistributed.text);
  assert.match(redistributed.text, LOCKED_MESSAGE);
  assert.equal(db(`select "expiresAt" from "Recipient" where id = ${signer.recipientId}`), expiresAt);
  assert.equal((await get(`/termos/${termoId}`)).body.status, 'EXPIRED');
  assertError(await post(`/termos/${termoId}/reenviar`), 409, 'NOT_PENDING');
  assertError(await post(`/termos/${termoId}/cancelar`), 409, 'NOT_PENDING');

  // O externalId de um termo vencido fica livre para um termo novo.
  const again = await createTermo({ externalId: extId('expired'), signerEmail: external('expired2') });

  assert.equal(again.status, 201, again.text);
  assert.equal((await post(`/termos/${again.body.termoId}/cancelar`)).status, 200);
});

test('assinado e ainda não selado: cancelar e reenviar dão 409 NOT_PENDING', async () => {
  const created = await createTermo({ externalId: extId('sealing'), signerEmail: external('sealing') });

  assert.equal(created.status, 201, created.text);

  const termoId = created.body.termoId;
  const signer = signerOf(termoId);

  // O intervalo entre a assinatura e o fim da selagem, posto no banco por instantes.
  db(`update "Recipient" set "signingStatus" = 'SIGNED' where id = ${signer.recipientId}`);

  try {
    assert.equal((await get(`/termos/${termoId}`)).body.status, 'PENDING');

    const cancelled = await post(`/termos/${termoId}/cancelar`);

    assertError(cancelled, 409, 'NOT_PENDING');
    assert.match(cancelled.body.error.message, /já assinou/);
    assertError(await post(`/termos/${termoId}/reenviar`), 409, 'NOT_PENDING');
    assert.equal(db(`select status from "Envelope" where id = '${termoId}'`), 'PENDING');
  } finally {
    db(`update "Recipient" set "signingStatus" = 'NOT_SIGNED' where id = ${signer.recipientId}`);
  }

  assert.equal((await post(`/termos/${termoId}/cancelar`)).status, 200);
});

test('Zapier: só o admin do sistema cria webhook (token comum recebe 401)', async () => {
  const subscribe = (token) =>
    fetch(`${BASE_URL}/api/v1/zapier/subscribe`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: `https://93.184.216.34/zapier-${RUN}`, eventTrigger: 'DOCUMENT_SIGNED' }),
    }).then(readJson);

  const normal = await subscribe(process.env.REVSIGN_API_TOKEN);

  assert.equal(normal.status, 401, normal.text);
  assert.equal(db(`select count(*) from "Webhook" where "webhookUrl" like '%zapier-${RUN}'`), '0');

  const adminToken = process.env.REVSIGN_SENDER_API_TOKEN;

  assert.ok(adminToken, 'defina REVSIGN_SENDER_API_TOKEN (token de uma conta ADMIN)');

  try {
    const admin = await subscribe(adminToken);

    assert.equal(admin.status, 200, admin.text);
    assert.equal(db(`select count(*) from "Webhook" where "webhookUrl" like '%zapier-${RUN}'`), '1');
  } finally {
    db(`delete from "Webhook" where "webhookUrl" like '%zapier-${RUN}'`);
  }
});

test('portão: sempre CPF e nascimento, só o CPF do termo passa, sem checagens de vínculo e sem criar vínculo', async () => {
  const signer = signerOf(fx.main);

  // João já tem o CPF ligado a outro e-mail e a base traz outro e-mail para ele: num documento comum, isso bloquearia.
  db(
    `insert into "RevalleEmailLink" (id, email, cpf) values ('pat-link-${RUN}', '${LINKED_ELSEWHERE_EMAIL}', '${JOAO.cpf}')`,
  );

  // Antes do portão, nada assina.
  const early = await trpc('envelope.field.sign', {
    token: signer.token,
    fieldId: signer.fieldIds[0],
    fieldValue: { type: 'SIGNATURE', value: 'x' },
  });

  assert.notEqual(early.status, 200, early.text);

  const accepted = await gate('acceptTerm', { token: signer.token, termVersion: '1' });

  assert.equal(accepted.state?.status, 'IDENTITY_REQUIRED', accepted.text);
  assert.equal(accepted.state?.attemptsLeft, 5);

  // Outro colaborador da base, com CPF e data certos: erro comum, conta tentativa.
  const other = await gate('verifyIdentity', { token: signer.token, ...MARIA });

  assert.equal(other.state?.status, 'IDENTITY_REQUIRED', other.text);
  assert.equal(other.state?.attemptsLeft, 4);

  const wrongDate = await gate('verifyIdentity', { token: signer.token, cpf: JOAO.cpf, birthDate: '01/01/1980' });

  assert.equal(wrongDate.state?.attemptsLeft, 3, wrongDate.text);

  const failures = db(
    `select data->>'cpfMasked' from "DocumentAuditLog" where "envelopeId" = '${fx.main}' and type = 'REVALLE_IDENTITY_FAILED'`,
  )
    .split('\n')
    .sort();

  assert.deepEqual(failures, ['***.533.447-**', '***.719.364-**']);

  const verified = await gate('verifyIdentity', { token: signer.token, ...JOAO });

  assert.equal(verified.state?.status, 'IDENTITY_CONFIRM', verified.text);
  assert.equal(verified.state?.preview?.primeiroNome, 'João');

  const confirmed = await gate('confirmIdentity', { token: signer.token, isMe: true });

  assert.equal(confirmed.state?.status, 'PASSED', confirmed.text);
  assert.equal(
    db(`select "identityStatus" || '|' || cpf from "RevalleRecipientGate" where "recipientId" = ${signer.recipientId}`),
    `CONFIRMED|${JOAO.cpf}`,
  );
  assert.equal(db(`select count(*) from "RevalleEmailLink" where email = '${signer.email}'`), '0');
  assert.equal(db(`select email from "RevalleEmailLink" where cpf = '${JOAO.cpf}'`), LINKED_ELSEWHERE_EMAIL);
  assert.equal(
    db(
      `select data->>'cpfMasked' from "DocumentAuditLog" where "envelopeId" = '${fx.main}' and type = 'REVALLE_IDENTITY_CONFIRMED'`,
    ),
    '***.719.364-**',
  );

  db(`delete from "RevalleEmailLink" where id = 'pat-link-${RUN}'`);
});

test('assinatura completa com o código do Mailpit: termo.signed e o PDF baixado é o selado (SHA-256 do /verificar)', async () => {
  const signer = signerOf(fx.main);

  await signFields(signer);

  const completed = await completeWithCode({ token: signer.token, documentId: signer.documentId, email: signer.email });

  assert.equal(completed.status, 200, completed.text);

  const status = await waitTermoStatus(fx.main, 'SIGNED');

  assert.ok(status.body.completedAt);
  assert.ok(status.body.signer.signedAt);

  const [event] = await waitEvent(fx.main, 'termo.signed');

  assert.ok(event.verified, 'HMAC do aviso não confere');
  assert.equal(event.body.status, 'SIGNED');
  assert.ok(!event.rawBody.includes(JOAO.cpf));

  const pdf = await fetchIdempotent(`${API}/termos/${fx.main}/pdf`, { headers: auth() }, async (res) => ({
    status: res.status,
    headers: res.headers,
    bytes: Buffer.from(await res.arrayBuffer()),
  }));

  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.bytes.subarray(0, 5).toString('latin1'), '%PDF-');

  const hash = sha256(pdf.bytes);

  assert.equal(pdf.headers.get('x-revsign-sha256'), hash);

  const finalSha256 = db(
    `select h."finalSha256" from "RevalleDocumentHash" h join "EnvelopeItem" i on i.id = h."envelopeItemId" where i."envelopeId" = '${fx.main}'`,
  );

  assert.equal(hash, finalSha256);

  const code = db(`select "verificationCode" from "RevalleSignatureProof" where "recipientId" = ${signer.recipientId}`);
  const page = await fetchIdempotent(`${BASE_URL}/verificar?codigo=${encodeURIComponent(code)}`, {}, (res) =>
    res.text(),
  );

  assert.ok(page.includes(hash), 'o /verificar não mostra o SHA-256 do PDF baixado');
  assert.ok(page.includes('João Exemplo Pereira'));
  assert.ok(!page.includes(JOAO.cpf), 'CPF completo no /verificar');

  // O PDF final é maior que o enviado (carimbo e certificado).
  assert.ok(pdf.bytes.length > TERMO_PDF.length);
  assertError(await post(`/termos/${fx.main}/cancelar`), 409, 'NOT_PENDING');
});

test('termo assinado: a exclusão é recusada e, mesmo marcado como excluído, continua SIGNED com o PDF', async () => {
  const deleted = await api('POST', '/envelope/delete', { envelopeId: fx.main });

  assert.notEqual(deleted.status, 200, deleted.text);
  assert.match(deleted.text, DELETE_MESSAGE);

  // Exclusão "branda" (só esconde da lista) posta no banco por instantes: o estado e o PDF não mudam.
  db(`update "Envelope" set "deletedAt" = now() where id = '${fx.main}'`);

  try {
    assert.equal((await get(`/termos/${fx.main}`)).body.status, 'SIGNED');
    assert.equal((await fetchIdempotent(`${API}/termos/${fx.main}/pdf`, { headers: auth() }, readJson)).status, 200);
  } finally {
    db(`update "Envelope" set "deletedAt" = null where id = '${fx.main}'`);
  }

  await sleep(1500);
  assert.equal(
    received.filter((hit) => hit.body?.termoId === fx.main && hit.body?.event === 'termo.cancelled').length,
    0,
  );
});

test('cancelar pela tela continua possível e avisa termo.cancelled', async () => {
  const userCookie = await signIn(process.env.REVSIGN_USER_EMAIL, process.env.REVSIGN_USER_PASSWORD);
  const teamId = db(`select "teamId" from "Envelope" where id = '${fx.locked}'`);
  const cancelled = await trpcAs(
    userCookie,
    'mutation',
    'envelope.cancel',
    { envelopeId: fx.locked, reason: 'pela tela' },
    { 'x-team-id': teamId },
  );

  assert.equal(cancelled.status, 200, cancelled.text);
  await waitEvent(fx.locked, 'termo.cancelled');
  assert.equal((await get(`/termos/${fx.locked}`)).body.status, 'CANCELLED');
});

test('recusa: termo.rejected com o motivo; o portão volta a pedir CPF (sem vínculo do termo anterior)', async () => {
  const email = external('reject');
  const created = await createTermo({ externalId: extId('reject'), kind: 'DEVOLUCAO', signerEmail: email });

  assert.equal(created.status, 201, created.text);

  const signer = signerOf(created.body.termoId);

  await passGate(signer.token, JOAO);

  const rejected = await trpc('recipient.rejectDocumentWithToken', {
    token: signer.token,
    documentId: signer.documentId,
    reason: 'Equipamento com defeito',
  });

  assert.equal(rejected.status, 200, rejected.text);

  const [event] = await waitEvent(created.body.termoId, 'termo.rejected');

  assert.ok(event.verified);
  assert.equal(event.body.status, 'REJECTED');
  assert.equal(event.body.rejectionReason, 'Equipamento com defeito');

  const status = await waitTermoStatus(created.body.termoId, 'REJECTED');

  assert.equal(status.body.signer.rejectionReason, 'Equipamento com defeito');
  assertError(await get(`/termos/${created.body.termoId}/pdf`), 409, 'NOT_SIGNED');
});

test('aviso que falha é entregue de novo com o mesmo eventId', async () => {
  const id = extId('retry');

  // A primeira entrega do termo.sent deste termo responde 500.
  failNext.add(`${id}|termo.sent`);

  const created = await createTermo({ externalId: id, signerEmail: external('retry') });

  assert.equal(created.status, 201, created.text);

  const termoId = created.body.termoId;
  const hits = await waitEvent(termoId, 'termo.sent', { count: 2, timeoutMs: 120_000 });

  assert.equal(hits[0].answered, 500);
  assert.equal(hits[1].answered, 200);
  assert.equal(hits[0].body.eventId, hits[1].body.eventId);
  assert.equal(hits[0].rawBody, hits[1].rawBody, 'o corpo muda entre tentativas');
  assert.ok(hits.every((hit) => hit.verified));

  // A gravação da entrega vem logo depois da resposta.
  await sleep(1000);

  const row = db(
    `select attempts || '|' || ("deliveredAt" is not null) || '|' || coalesce("lastError", '') from "RevallePatrimonioEvent" where id = '${hits[0].body.eventId}'`,
  );

  assert.equal(row, '2|true|');
  assert.equal((await post(`/termos/${termoId}/cancelar`)).status, 200);
});

test('integração desligada (sem a chave): todas as rotas respondem 404 NOT_CONFIGURED', async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const envFile = process.env.REVSIGN_HML_ENV_FILE ?? path.resolve(repoRoot, '../local-hml/hml.env');
  const image = execFileSync('docker', ['inspect', '--format', '{{.Config.Image}}', APP_CONTAINER], {
    encoding: 'utf8',
  }).trim();
  // Sem PATRIMONIO_TEST_API_KEY o compose.test.yml usa a chave de teste; vazia, desliga a integração.
  const { PATRIMONIO_TEST_API_KEY: _ignored, ...baseEnv } = process.env;
  const compose = (apiKeyOverride) =>
    execFileSync(
      'docker',
      [
        'compose',
        '-f',
        'revalle/deploy/compose.hml.yml',
        '-f',
        'revalle/deploy/compose.test.yml',
        '--env-file',
        envFile,
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        'documenso',
      ],
      {
        cwd: repoRoot,
        env: {
          ...baseEnv,
          REVSIGN_IMAGE: image,
          ...(apiKeyOverride === undefined ? {} : { PATRIMONIO_TEST_API_KEY: apiKeyOverride }),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
  const waitHealthy = async () => {
    const deadline = performance.now() + 180_000;

    do {
      try {
        const res = await fetch(`${BASE_URL}/api/health`);

        if (res.ok) {
          return;
        }
      } catch {
        // subindo
      }

      await sleep(2000);
    } while (performance.now() < deadline);

    throw new Error('o app não voltou em 180 s');
  };

  try {
    compose('');
    await waitHealthy();

    for (const res of [
      await get('/termos?externalId=X'),
      await get('/termos?externalId=X', { key: null }),
      await get(`/termos/${fx.main}`),
      await get(`/termos/${fx.main}/pdf`),
      await post(`/termos/${fx.main}/cancelar`),
      await post(`/termos/${fx.main}/reenviar`),
      await createTermo({ externalId: extId('off') }),
    ]) {
      assertError(res, 404, 'NOT_CONFIGURED');
    }
  } finally {
    // Volta a stack como estava (com a chave de teste do compose.test.yml).
    compose(undefined);
    await waitHealthy();
  }

  assert.equal((await get(`/termos/${fx.main}`)).body?.status, 'SIGNED');
});
