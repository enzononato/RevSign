// Aceite da Fase 4 (Task 9; spec §7.3 "Aceite"): um documento com TRÊS signatários em ordem sequencial, conferido no
// PDF final selado (carimbo de cada um, cada linha da tabela §7.3 no certificado, hash do original), no /verificar
// com cada código e na selagem ICP (pdfsig válido, DocMDP P=2, política AD-RB). Roda contra a stack local.
//
// Signatários:
//   1. o próprio remetente (conta com e-mail da empresa), já vinculado ao CPF dele: caminho do vínculo;
//   2. um colaborador com e-mail já vinculado (vínculo feito antes, neste mesmo teste, num documento descartável);
//   3. um colaborador na primeira assinatura: CPF + data de nascimento e "sou eu".
// Só o 2 desenha. Localização do aparelho: 1 GRANTED, 2 DENIED, 3 não envia (NOT_REQUESTED).
//
// Variáveis: REVSIGN_SENDER_API_TOKEN (token de API do time pessoal do remetente, criado na tela Configurações → API
// da conta dele) e REVSIGN_SENDER_EMAIL (padrão: REVSIGN_ADMIN_EMAIL). Sem elas, o teste é pulado.
// Colaboradores FICTÍCIOS 7 a 9 de revalle/colaboradores/dev-seed.sql (bloco aceite-f4), exclusivos deste teste.
// Nunca imprime CPF completo, data de nascimento nem código do e-mail.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';

import {
  api,
  BASE_URL,
  brasilia,
  completeWithCode,
  createEnvelope,
  db,
  distribute,
  downloadItem,
  drawingPng,
  fetchIdempotent,
  poppler,
  retryCreateOnStaleSocket,
  trpc,
} from './helpers.mjs';

const SENDER_TOKEN = process.env.REVSIGN_SENDER_API_TOKEN;
const SENDER_EMAIL = (process.env.REVSIGN_SENDER_EMAIL ?? process.env.REVSIGN_ADMIN_EMAIL ?? '').toLowerCase();
const SKIP =
  !SENDER_TOKEN || !SENDER_EMAIL ? 'defina REVSIGN_SENDER_API_TOKEN e REVSIGN_SENDER_EMAIL (ver testes.md)' : false;

// Colaboradores fictícios do dev-seed (bloco aceite-f4).
const PEOPLE = [
  { cpf: '41000000141', birthDate: '12/05/1987' },
  { cpf: '41000000222', birthDate: '21/08/1993' },
  { cpf: '41000000303', birthDate: '30/11/2001' },
];
const ALL_CPFS = PEOPLE.map((person) => person.cpf);

const UA = {
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

// Página A4 do assets/example.pdf (596 × 842 pt); campos empilhados, um por signatário.
const PAGE = { width: 596, height: 842 };
const FIELD = { positionX: 10, width: 36, height: 9 };
const FIELD_Y = [52, 64, 76];

const FACTOR_LABELS = {
  EMAIL_LINK: 'Link por e-mail',
  EMAIL_CODE: 'Código por e-mail',
  EMPLOYEE_CONFIRMATION: 'Confirmação de colaborador',
  EMPLOYEE_LINKED: 'Vínculo de colaborador já confirmado',
};

// Rótulos da coluna "Detalhes" do certificado, na ordem em que aparecem.
const DETAIL_LABELS = [
  'Enviado',
  'Visualizado',
  'Assinou em',
  'Motivo',
  'CPF',
  'Matrícula',
  'Cargo',
  'Setor',
  'Unidade',
  'Situação',
  'Verificação',
  'Termo aceito',
  'Ordem de assinatura',
  'Localização aproximada (IP)',
  'Localização do aparelho',
  'Assinatura visual',
  'Código de verificação',
];
const SIGNATURE_COLUMN_LABELS = ['ID da Assinatura', 'Endereço IP', 'Dispositivo'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const squash = (text) => text.replace(/\s+/g, ' ').trim();
const compact = (text) => text.replace(/\s+/g, '');
const maskCpf = (cpf) => `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`;
const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;

// Tira dos textos que vão para mensagens de erro qualquer CPF completo (com ou sem pontuação).
const redact = (text) =>
  ALL_CPFS.reduce(
    (out, cpf) =>
      out
        .replaceAll(cpf, '[CPF]')
        .replaceAll(`${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`, '[CPF]'),
    String(text),
  );

const baseSql = (query) =>
  execFileSync(
    'docker',
    ['exec', 'revsign-hml-colaboradores-db-1', 'psql', '-U', 'postgres', '-d', 'colaboradores', '-At', '-c', query],
    { encoding: 'utf8' },
  ).trim();

const json = (query) => JSON.parse(db(query) || 'null');
const linkOf = (email) => db(`select cpf from "RevalleEmailLink" where lower(email) = ${sql(email.toLowerCase())}`);

const gateCall = async (procedure, input, headers) => {
  const res = await trpc(`revalle.gate.${procedure}`, input, headers);

  assert.equal(res.status, 200, `revalle.gate.${procedure}: ${res.status}`);

  return res.body?.result?.data?.json;
};

// Portão como a tela faz. Devolve os estados vistos (sem CPF nem data na saída).
const passGate = async (token, person, headers) => {
  const states = [await gateCall('acceptTerm', { token, termVersion: '1' }, headers)];

  if (states[0]?.status === 'IDENTITY_REQUIRED') {
    states.push(await gateCall('verifyIdentity', { token, ...person }, headers));
    states.push(await gateCall('confirmIdentity', { token, isMe: true }, headers));
  }

  return states;
};

// Abre a página de assinatura como o navegador (registra a abertura). Não segue redirecionamento.
const openSigningPage = (token, headers) =>
  fetchIdempotent(`${BASE_URL}/sign/${token}`, { redirect: 'manual', headers }, async (res) => {
    await res.text();

    return { status: res.status, location: res.headers.get('location') ?? '' };
  });

const docId = (envelope) => Number.parseInt(envelope.secondaryId.split('_')[1], 10);

// Documento descartável de um signatário, só para o portão criar o vínculo e-mail ↔ CPF. Depois é excluído.
const linkThroughThrowaway = async (email, person) => {
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({
      apiToken: SENDER_TOKEN,
      title: `[TESTE] aceite F4 vínculo ${Date.now().toString(36)}`,
      recipients: [{ email }],
    }),
  );

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id, { apiToken: SENDER_TOKEN });
  const states = await passGate(recipient.token, person, {});

  assert.equal(states.at(-1)?.status, 'PASSED', 'portão do documento descartável não passou');
  assert.ok(linkOf(email) === person.cpf, 'vínculo e-mail ↔ CPF não foi criado pelo documento descartável');

  const deleted = await api('POST', '/envelope/delete', { envelopeId: created.id }, { apiToken: SENDER_TOKEN });

  assert.equal(deleted.status, 200, deleted.text);
};

// Palavras do PDF com posição (pdftotext -bbox), por página.
const parseBbox = (html) =>
  html
    .split('<page ')
    .slice(1)
    .map((chunk) => {
      const [, width, height] = chunk.match(/width="([\d.]+)" height="([\d.]+)"/);
      const words = [
        ...chunk.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/word>/g),
      ].map(([, x, y, x2, y2, text]) => ({
        x: Number(x),
        y: Number(y),
        x2: Number(x2),
        y2: Number(y2),
        text: text
          .replaceAll('&lt;', '<')
          .replaceAll('&gt;', '>')
          .replaceAll('&quot;', '"')
          .replaceAll('&#39;', "'")
          .replaceAll('&amp;', '&')
          .trim(),
      }));

      return { width: Number(width), height: Number(height), words };
    });

// Junta palavras em linhas (mesma altura) e as linhas de cima para baixo.
const toText = (words) => {
  const lines = [];

  for (const word of [...words].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find((candidate) => Math.abs(candidate.y - word.y) < 2.5);

    if (line) {
      line.words.push(word);
    } else {
      lines.push({ y: word.y, words: [word] });
    }
  }

  return lines
    .sort((a, b) => a.y - b.y)
    .map((line) =>
      line.words
        .sort((a, b) => a.x - b.x)
        .map((word) => word.text)
        .join(' '),
    )
    .join('\n');
};

// Linhas "Rótulo: valor" de uma coluna, na ordem dada; o valor vai até o próximo rótulo encontrado.
const labelValues = (text, labels) => {
  const flat = squash(text);
  const found = labels
    .map((label) => ({ label, index: flat.indexOf(`${label}:`) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index);

  return Object.fromEntries(
    found.map((item, i) => [
      item.label,
      flat.slice(item.index + item.label.length + 1, found[i + 1]?.index ?? flat.length).trim(),
    ]),
  );
};

// Cada linha da tabela do certificado (um destinatário) começa no "Enviado:" da coluna Detalhes.
// Devolve as três colunas de cada linha: identidade, assinatura e detalhes.
const certificateRows = (pages) => {
  const rows = [];

  for (const [pageIndex, page] of pages.entries()) {
    const sent = page.words.filter((word) => word.text === 'Enviado:').sort((a, b) => a.y - b.y);

    if (sent.length === 0) {
      continue;
    }

    const columnThreeX = Math.min(...sent.map((word) => word.x)) - 1;
    const columnTwoX = Math.min(...page.words.filter((word) => word.text === 'Endereço').map((word) => word.x)) - 1;
    const footer = page.words.find(
      (word) => word.text === 'Geolocation' || word.text === 'Envelope:' || word.text === 'documento:',
    );
    const pageBottom = footer ? footer.y - 2 : page.height;

    for (const [index, start] of sent.entries()) {
      const top = start.y - 8;
      const bottom = sent[index + 1] ? sent[index + 1].y - 8 : pageBottom;
      const inRow = page.words.filter((word) => word.y >= top && word.y < bottom);

      rows.push({
        page: pageIndex + 1,
        identity: toText(inRow.filter((word) => word.x < columnTwoX)),
        signature: toText(inRow.filter((word) => word.x >= columnTwoX && word.x < columnThreeX)),
        details: toText(inRow.filter((word) => word.x >= columnThreeX)),
      });
    }
  }

  return rows;
};

const waitStatus = async (envelopeId, status) => {
  for (let i = 0; i < 90 && db(`select status from "Envelope" where id = ${sql(envelopeId)}`) !== status; i += 1) {
    await sleep(2000);
  }

  return db(`select status from "Envelope" where id = ${sql(envelopeId)}`);
};

const verifyPage = (code) =>
  fetchIdempotent(`${BASE_URL}/verificar?codigo=${encodeURIComponent(code)}`, {}, async (res) => ({
    status: res.status,
    // Texto visível: sem comentários do React, tags e entidades.
    text: squash(
      (await res.text())
        .replace(/<script[\s\S]*?<\/script>/g, ' ')
        .replace(/<!-- -->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replaceAll('&amp;', '&')
        .replaceAll('&#x27;', "'")
        .replaceAll('&quot;', '"'),
    ),
  }));

const fx = {};

before(async () => {
  if (SKIP) {
    return;
  }

  db('delete from "RateLimit"');

  // Colaboradores fictícios carregados na base (bloco aceite-f4 do dev-seed.sql).
  const inBase = baseSql(
    `select count(*) from rh_colaboradores where cpf_completo in (${ALL_CPFS.map(sql).join(',')}) and nome_completo like 'Teste Aceite F4 %'`,
  );

  assert.equal(inBase, '3', 'colaboradores do aceite ausentes na base: rode o bloco aceite-f4 (ver testes.md)');

  const hr = PEOPLE.map((person) => {
    const [nome, matricula, cargo, setor, unidade, situacao] = baseSql(
      `select nome_completo, matricula_rh, cargo_nome, setor_nome, unidade_nome, status_rh from rh_colaboradores where cpf_completo = ${sql(person.cpf)}`,
    ).split('|');

    return { nome, matricula, cargo, setor, unidade, situacao };
  });

  // Vínculos. Os CPFs 2 e 3 são exclusivos deste teste e são soltos a cada execução (o vínculo é permanente e o CPF é
  // único, então e-mails novos precisam de CPFs livres). O remetente fica vinculado ao CPF 1 entre execuções; outros
  // testes podem soltar o vínculo da conta de admin, e aí ele é refeito aqui por um documento descartável.
  db(`delete from "RevalleEmailLink" where cpf in (${sql(PEOPLE[1].cpf)}, ${sql(PEOPLE[2].cpf)})`);

  if (linkOf(SENDER_EMAIL) !== PEOPLE[0].cpf) {
    db(`delete from "RevalleEmailLink" where lower(email) = ${sql(SENDER_EMAIL)} or cpf = ${sql(PEOPLE[0].cpf)}`);
    await linkThroughThrowaway(SENDER_EMAIL, PEOPLE[0]);
  }

  // Base 36: o e-mail do código cita o título, e um número de 6 dígitos nele seria lido como o código.
  const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
  const linkedEmail = `aceite-f4-vinculado-${run}@revalle.com.br`;
  const firstTimeEmail = `aceite-f4-primeira-${run}@revalle.com.br`;

  await linkThroughThrowaway(linkedEmail, PEOPLE[1]);

  fx.signers = [
    {
      key: 'remetente',
      name: 'Remetente Aceite',
      email: SENDER_EMAIL,
      person: PEOPLE[0],
      hr: hr[0],
      headers: { 'User-Agent': UA.windows, 'X-Forwarded-For': '177.71.207.1' },
      device: 'Windows 10 · Chrome 130',
      geolocation: { status: 'GRANTED', lat: -12.13562, lon: -38.41907, accuracyM: 30 },
      expectedDeviceLocation: '-12,1356, -38,4191 (±30 m)',
      draws: false,
      factors: ['EMAIL_LINK', 'EMAIL_CODE', 'EMPLOYEE_LINKED'],
      identityStatus: 'LINKED',
    },
    {
      key: 'vinculado',
      name: 'Colaborador Vinculado',
      email: linkedEmail,
      person: PEOPLE[1],
      hr: hr[1],
      headers: { 'User-Agent': UA.android, 'X-Forwarded-For': '189.6.1.1' },
      device: 'Android 14 · Chrome 130',
      geolocation: { status: 'DENIED' },
      expectedDeviceLocation: 'não autorizada',
      draws: true,
      factors: ['EMAIL_LINK', 'EMAIL_CODE', 'EMPLOYEE_LINKED'],
      identityStatus: 'LINKED',
    },
    {
      key: 'primeira',
      name: 'Primeira Assinatura',
      email: firstTimeEmail,
      person: PEOPLE[2],
      hr: hr[2],
      headers: { 'User-Agent': UA.iphone, 'X-Forwarded-For': '203.0.113.7' },
      device: 'iOS 17.5 · Mobile Safari 17',
      geolocation: undefined,
      expectedDeviceLocation: 'não solicitada',
      draws: false,
      factors: ['EMAIL_LINK', 'EMAIL_CODE', 'EMPLOYEE_CONFIRMATION'],
      identityStatus: 'CONFIRMED',
    },
  ];

  fx.title = `[TESTE] aceite F4 ${run}`;

  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({
      apiToken: SENDER_TOKEN,
      title: fx.title,
      meta: { signingOrder: 'SEQUENTIAL' },
      recipients: fx.signers.map((signer, index) => ({
        email: signer.email,
        name: signer.name,
        signingOrder: index + 1,
        fields: [{ type: 'SIGNATURE', page: 1, ...FIELD, positionY: FIELD_Y[index] }],
      })),
    }),
  );

  assert.equal(created.status, 200, created.text);
  fx.envelope = created.envelope;
  fx.owner = db(
    `select u.email from "User" u join "Envelope" e on e."userId" = u.id where e.id = ${sql(created.id)}`,
  ).toLowerCase();

  const recipients = await distribute(created.id, { apiToken: SENDER_TOKEN });
  const documentId = docId(created.envelope);

  for (const signer of fx.signers) {
    signer.recipient = recipients.find((r) => r.email.toLowerCase() === signer.email.toLowerCase());
    signer.field = created.envelope.fields.find((f) => f.recipientId === signer.recipient.id && f.type === 'SIGNATURE');
  }

  const [first, second, third] = fx.signers;

  // Fora da vez: o 3º passa pelo portão (a tela mostra o portão antes de tudo), mas a página o manda esperar
  // e a conclusão é recusada enquanto o 2º não assinar.
  db('delete from "RateLimit"');
  third.gateStates = await passGate(third.recipient.token, third.person, third.headers);
  fx.outOfTurn = {
    page: await openSigningPage(third.recipient.token, third.headers),
    completion: await completeWithCode({
      token: third.recipient.token,
      documentId,
      email: third.email,
      headers: third.headers,
    }),
    status: db(`select "signingStatus" from "Recipient" where id = ${third.recipient.id}`),
    proofs: db(`select count(*) from "RevalleSignatureProof" where "recipientId" = ${third.recipient.id}`),
  };

  for (const signer of [first, second, third]) {
    db('delete from "RateLimit"');

    if (signer !== third) {
      signer.gateStates = await passGate(signer.recipient.token, signer.person, signer.headers);
    }

    signer.page = await openSigningPage(signer.recipient.token, signer.headers);

    if (signer.draws) {
      signer.drawn = await trpc(
        'envelope.field.sign',
        {
          token: signer.recipient.token,
          fieldId: signer.field.id,
          fieldValue: { type: 'SIGNATURE', value: drawingPng() },
        },
        signer.headers,
      );
    }

    signer.completion = await completeWithCode({
      token: signer.recipient.token,
      documentId,
      email: signer.email,
      headers: signer.headers,
      extra: signer.geolocation ? { revalleGeolocation: signer.geolocation } : {},
    });
    assert.equal(signer.completion.status, 200, `conclusão de ${signer.key}: ${redact(signer.completion.text)}`);

    signer.proof = json(
      `select row_to_json(p) from "RevalleSignatureProof" p where p."recipientId" = ${signer.recipient.id}`,
    );
    signer.gate = json(
      `select row_to_json(g) from (select "identityStatus", "termVersion", "termAcceptedAt" from "RevalleRecipientGate" where "recipientId" = ${signer.recipient.id}) g`,
    );
    signer.opened = db(
      `select to_json("createdAt")#>>'{}' from "DocumentAuditLog" where "envelopeId" = ${sql(created.id)} and type = 'DOCUMENT_OPENED' and (data->>'recipientId')::int = ${signer.recipient.id} order by "createdAt" limit 1`,
    );
    signer.signatureImage = db(
      `select coalesce(length(s."signatureImageAsBase64"), 0) from "Signature" s where s."fieldId" = ${signer.field.id}`,
    );
  }

  fx.status = await waitStatus(created.id, 'COMPLETED');
  fx.sent = db(
    `select to_json("createdAt")#>>'{}' from "DocumentAuditLog" where "envelopeId" = ${sql(created.id)} and type = 'DOCUMENT_SENT' order by "createdAt" limit 1`,
  );
  fx.hash = json(
    `select row_to_json(h) from (select "originalSha256", "finalSha256" from "RevalleDocumentHash" where "envelopeItemId" = ${sql(created.envelope.envelopeItems[0].id)}) h`,
  );

  // PDFs: original e final selado.
  fx.dir = mkdtempSync(path.join(tmpdir(), 'aceite-f4-'));

  const itemId = created.envelope.envelopeItems[0].id;
  const original = await downloadItem(itemId, 'original', { apiToken: SENDER_TOKEN });
  const signed = await downloadItem(itemId, 'signed', { apiToken: SENDER_TOKEN });

  writeFileSync(path.join(fx.dir, 'original.pdf'), original);
  writeFileSync(path.join(fx.dir, 'signed.pdf'), signed);
  fx.originalSha256 = createHash('sha256').update(original).digest('hex');
  fx.signedSha256 = createHash('sha256')
    .update(readFileSync(path.join(fx.dir, 'signed.pdf')))
    .digest('hex');

  // Uma passada do poppler: o texto de cada campo (recorte da área do campo na página 1), o texto todo e as
  // palavras com posição de todas as páginas.
  const crops = FIELD_Y.map((y) => {
    const box = {
      x: Math.floor((FIELD.positionX / 100) * PAGE.width) - 1,
      y: Math.floor((y / 100) * PAGE.height) - 1,
      w: Math.ceil((FIELD.width / 100) * PAGE.width) + 2,
      h: Math.ceil((FIELD.height / 100) * PAGE.height) + 2,
    };

    return `pdftotext -f 1 -l 1 -x ${box.x} -y ${box.y} -W ${box.w} -H ${box.h} /pdf/signed.pdf -`;
  });
  const [info, all, bbox, images, ...stamps] = poppler(
    fx.dir,
    [
      'pdfinfo /pdf/signed.pdf',
      'pdftotext /pdf/signed.pdf -',
      'pdftotext -bbox /pdf/signed.pdf -',
      'pdfimages -list /pdf/signed.pdf',
      ...crops,
    ].join(' && echo @@@@ && '),
  ).split('@@@@');

  fx.pdf = {
    pages: Number(info.match(/^Pages:\s+(\d+)/m)[1]),
    all,
    stamps,
    words: parseBbox(bbox),
    // Imagens (pdfimages -list: página, número, tipo, largura, altura); máscaras de transparência ficam de fora.
    images: images
      .split('\n')
      .map((row) => row.match(/^\s*(\d+)\s+\d+\s+image\s+(\d+)\s+(\d+)/))
      .filter(Boolean)
      .map(([, page, width, height]) => ({ page: Number(page), width: Number(width), height: Number(height) })),
  };
  fx.pdf.rows = certificateRows(fx.pdf.words);

  // Selagem: pdfsig (verify-signed-pdf.sh) e o dicionário/atributos da assinatura (inspect-pdf-signature.sh).
  const run2 = (script, args) => {
    try {
      return { ok: true, output: execFileSync('sh', [path.resolve(script), ...args], { encoding: 'utf8' }) };
    } catch (error) {
      return { ok: false, output: `${error.stdout}${error.stderr}` };
    }
  };

  fx.verify = run2('scripts/revalle/verify-signed-pdf.sh', [
    path.join(fx.dir, 'signed.pdf'),
    path.join(fx.dir, 'original.pdf'),
  ]);
  fx.inspect = run2('scripts/revalle/inspect-pdf-signature.sh', [path.join(fx.dir, 'signed.pdf')]);

  // QR do certificado: link /share/qr_… do envelope (página pública do documento).
  fx.qrToken = db(`select "qrToken" from "Envelope" where id = ${sql(created.id)}`);
  fx.share = await fetchIdempotent(`${BASE_URL}/share/${fx.qrToken}`, {}, async (res) => ({
    status: res.status,
    text: await res.text(),
  }));

  db('delete from "RateLimit"');
  fx.verifyPages = [];

  for (const signer of fx.signers) {
    fx.verifyPages.push(await verifyPage(signer.proof.verificationCode));
  }
});

const opts = SKIP ? { skip: SKIP } : {};

test('o remetente é uma conta com e-mail da empresa e é o 1º signatário', opts, () => {
  assert.match(SENDER_EMAIL, /@revalle\.com\.br$/);
  assert.equal(fx.owner, SENDER_EMAIL, 'o token não é da conta do remetente');
  assert.equal(fx.signers[0].email, fx.owner);
  assert.equal(
    db(
      `select "signingOrder" from "DocumentMeta" m join "Envelope" e on e."documentMetaId" = m.id where e.id = ${sql(fx.envelope.id)}`,
    ),
    'SEQUENTIAL',
  );
});

test('ordem sequencial: o 3º não assina antes do 2º (página manda esperar, conclusão recusada)', opts, () => {
  const { page, completion, status, proofs } = fx.outOfTurn;

  assert.equal(page.status, 302, 'a página de assinatura deveria redirecionar quem está fora da vez');
  assert.match(page.location, /\/sign\/[^/]+\/waiting$/);
  assert.notEqual(completion.status, 200, 'o 3º concluiu fora da vez');
  assert.match(completion.text, /RECIPIENT_OUT_OF_TURN/);
  assert.equal(status, 'NOT_SIGNED');
  assert.equal(proofs, '0');

  // Na vez de cada um, a página abre.
  for (const signer of fx.signers) {
    assert.equal(signer.page.status, 200, `página de ${signer.key} na vez dele`);
  }

  // A ordem real das assinaturas: 1 < 2 < 3.
  const signedAt = fx.signers.map((signer) => new Date(`${signer.proof.signedAt}Z`).getTime());

  assert.ok(signedAt[0] < signedAt[1] && signedAt[1] < signedAt[2], 'assinaturas fora de ordem');
  assert.equal(fx.status, 'COMPLETED');
});

test(
  'portão: remetente e vinculado pelo vínculo (LINKED); a primeira assinatura confirma CPF + data (CONFIRMED)',
  opts,
  () => {
    const [first, second, third] = fx.signers;

    for (const signer of [first, second]) {
      assert.deepEqual(
        signer.gateStates.map((state) => state?.status),
        ['PASSED'],
        `${signer.key}: o vínculo deveria pular a identidade`,
      );
    }

    assert.deepEqual(
      third.gateStates.map((state) => state?.status),
      ['IDENTITY_REQUIRED', 'IDENTITY_CONFIRM', 'PASSED'],
    );
    assert.equal(third.gateStates[1].preview.primeiroNome, 'Teste');
    assert.ok(linkOf(third.email) === third.person.cpf, 'a primeira assinatura não criou o vínculo');

    for (const signer of fx.signers) {
      assert.equal(signer.gate.identityStatus, signer.identityStatus, signer.key);
      assert.deepEqual(
        signer.proof.factors.map((item) => item.factor),
        signer.factors,
        `fatores de ${signer.key}`,
      );
      assert.equal(signer.proof.identityVerified, true);
    }
  },
);

test('prova congelada: só o 2º desenhou; localização GRANTED, DENIED e NOT_REQUESTED', opts, () => {
  const [first, second, third] = fx.signers;

  assert.equal(second.drawn.status, 200, 'o PNG do desenho foi recusado');
  assert.ok(Number(second.signatureImage) > 100, 'imagem do desenho não gravada');
  assert.equal(second.proof.signatureKind, 'IMAGE');
  assert.equal(second.proof.drewSignature, true);

  for (const signer of [first, third]) {
    assert.equal(signer.proof.signatureKind, 'NONE', signer.key);
    assert.equal(signer.proof.drewSignature, false, signer.key);
    assert.equal(signer.signatureImage, '0', `${signer.key} não desenhou`);
  }

  assert.deepEqual(first.proof.deviceLocation, { status: 'GRANTED', lat: -12.13562, lon: -38.41907, accuracyM: 30 });
  assert.deepEqual(second.proof.deviceLocation, { status: 'DENIED' });
  assert.deepEqual(third.proof.deviceLocation, { status: 'NOT_REQUESTED' });

  for (const signer of fx.signers) {
    assert.equal(signer.proof.device, signer.device, `aparelho de ${signer.key}`);
    assert.equal(signer.proof.ipAddress, signer.headers['X-Forwarded-For']);
    assert.match(signer.proof.verificationCode, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  }

  assert.equal(new Set(fx.signers.map((signer) => signer.proof.verificationCode)).size, 3, 'códigos repetidos');
  // IP público brasileiro: cidade/UF pela base offline; IP de documentação (TEST-NET): sem local.
  assert.equal(first.proof.ipLocation?.countryIso, 'BR');
  assert.match(first.proof.ipLocation?.region ?? '', /^[A-Z]{2}$/);
  assert.equal(second.proof.ipLocation?.countryIso, 'BR');
  assert.equal(third.proof.ipLocation, null);
});

test('carimbo de cada signatário: as 5 linhas, com o CPF mascarado, dentro do próprio campo', opts, () => {
  const webapp = execFileSync('docker', ['exec', 'revsign-hml-documenso-1', 'printenv', 'NEXT_PUBLIC_WEBAPP_URL'], {
    encoding: 'utf8',
  })
    .trim()
    .replace(/\/$/, '');

  for (const [index, signer] of fx.signers.entries()) {
    const lines = [
      `Assinado eletronicamente por ${signer.hr.nome.toLocaleUpperCase('pt-BR')}`,
      `CPF ${maskCpf(signer.person.cpf)}`,
      `em ${brasilia(`${signer.proof.signedAt}Z`)} (horário de Brasília)`,
      `Código de verificação: ${signer.proof.verificationCode}`,
      `Confira em ${webapp}/verificar`,
    ];
    const crop = fx.pdf.stamps[index];

    assert.equal(signer.proof.employee.cpfMasked, maskCpf(signer.person.cpf));
    // A quebra de linha do carimbo depende do tamanho do campo; as 5 linhas, na ordem, sem contar espaços.
    assert.ok(compact(crop).includes(compact(lines.join(''))), `carimbo de ${signer.key}:\n${redact(crop)}`);

    for (const other of fx.signers.filter((s) => s !== signer)) {
      assert.ok(!crop.includes(other.proof.verificationCode), `código de ${other.key} no campo de ${signer.key}`);
    }
  }

  // Um carimbo por signatário na página 1, e só três.
  const page1 = squash(fx.pdf.all.split('\f')[0]);

  assert.equal(page1.split('Assinado eletronicamente por').length - 1, 3);
});

test('certificado: cada linha da tabela §7.3 para cada signatário, com os valores esperados', opts, () => {
  const { rows } = fx.pdf;

  assert.equal(rows.length, 3, `linhas do certificado: ${rows.length}`);

  for (const [index, signer] of fx.signers.entries()) {
    const matching = rows.filter((row) => row.details.includes(signer.proof.verificationCode));

    assert.equal(matching.length, 1, `bloco de ${signer.key} no certificado`);

    const [row] = matching;
    const details = labelValues(row.details, DETAIL_LABELS);
    const signature = labelValues(row.signature, SIGNATURE_COLUMN_LABELS);
    const ipLocation = signer.proof.ipLocation
      ? `${[signer.proof.ipLocation.city, signer.proof.ipLocation.region].filter(Boolean).join('/')}, Brasil`
      : 'não identificada';
    const expected = {
      Enviado: brasilia(`${fx.sent}Z`),
      Visualizado: brasilia(`${signer.opened}Z`),
      'Assinou em': brasilia(`${signer.proof.signedAt}Z`),
      Motivo: index === 0 ? 'Eu sou o proprietário deste documento' : 'Eu sou um signatário deste documento',
      CPF: maskCpf(signer.person.cpf),
      Matrícula: signer.hr.matricula,
      Cargo: signer.hr.cargo,
      Setor: signer.hr.setor,
      Unidade: signer.hr.unidade,
      Situação: signer.hr.situacao,
      Verificação: signer.proof.factors
        .map((item) => `${FACTOR_LABELS[item.factor]} (${brasilia(item.at)})`)
        .join(' · '),
      'Termo aceito': `Versão 1 em ${brasilia(`${signer.gate.termAcceptedAt}Z`)}`,
      'Ordem de assinatura': `${index + 1}º de 3`,
      'Localização aproximada (IP)': ipLocation,
      'Localização do aparelho': signer.expectedDeviceLocation,
      'Assinatura visual': signer.draws ? 'imagem (desenho/arquivo)' : 'somente carimbo',
      'Código de verificação': signer.proof.verificationCode,
    };
    const context = `\n--- ${signer.key} ---\n${redact(row.details)}`;

    assert.deepEqual(Object.keys(details), DETAIL_LABELS, `rótulos de ${signer.key}${context}`);

    for (const [label, value] of Object.entries(expected)) {
      assert.equal(details[label], value, `${signer.key} → ${label}${context}`);
    }

    // Nome e e-mail (coluna 1; o e-mail quebra em linhas), IP e aparelho (coluna 2).
    assert.ok(compact(row.identity).includes(compact(signer.name)), `nome de ${signer.key}`);
    assert.ok(compact(row.identity).includes(compact(signer.email)), `e-mail de ${signer.key}`);
    assert.equal(signature['Endereço IP'], signer.headers['X-Forwarded-For'], `IP de ${signer.key}`);
    assert.equal(signature.Dispositivo, signer.device, `aparelho de ${signer.key}`);

    // Caixa de assinatura: só carimbo diz "Assinado eletronicamente (carimbo)"; quem desenhou, não.
    assert.equal(
      squash(row.signature).includes('Assinado eletronicamente (carimbo)'),
      !signer.draws,
      `caixa de assinatura de ${signer.key}:\n${redact(row.signature)}`,
    );
  }
});

test('certificado: SHA-256 do original igual ao do banco e ao do arquivo enviado; ID do envelope e QR', opts, () => {
  const allPages = fx.pdf.all.split('\f');
  const certificatePages = allPages.filter((page) => page.includes('SHA-256 do original'));
  const certificatePageNumbers = allPages.flatMap((page, index) =>
    page.includes('Certificado de Assinatura') ? [index + 1] : [],
  );

  assert.ok(certificatePages.length >= 1);
  assert.match(fx.hash.originalSha256, /^[0-9a-f]{64}$/);
  assert.equal(fx.hash.originalSha256, fx.originalSha256, 'hash do original no banco ≠ arquivo original baixado');

  for (const page of certificatePages) {
    assert.ok(squash(page).includes(`SHA-256 do original: ${fx.hash.originalSha256}`), 'hash do original no cabeçalho');
  }

  assert.ok(fx.pdf.all.includes(fx.envelope.id), 'ID do envelope ausente');

  // Imagens das páginas do certificado: o QR (quadrado) e o desenho do 2º na caixa de assinatura dele (60×20).
  const certificateImages = fx.pdf.images.filter((image) => certificatePageNumbers.includes(image.page));
  const drawing = (image) => image.width === 60 && image.height === 20;

  assert.equal(
    certificateImages.filter((image) => image.width === image.height && image.width >= 100).length,
    1,
    `QR nas páginas do certificado ${certificatePageNumbers.join(', ')}`,
  );
  assert.equal(certificateImages.filter(drawing).length, 1, 'desenho do 2º na caixa de assinatura do certificado');
  // Página 1: o desenho entra uma vez só (no campo do 2º), além das imagens do original.
  assert.equal(fx.pdf.images.filter((image) => image.page === 1 && drawing(image)).length, 1, 'desenho na página 1');
  assert.match(fx.qrToken, /^qr_/);
  assert.equal(fx.share.status, 200, 'link do QR');
  assert.ok(fx.share.text.includes(fx.title), 'a página do QR não mostra o documento');
});

test('nenhum CPF completo no PDF nem no /verificar', opts, () => {
  const pdf = compact(fx.pdf.all).replace(/[.-]/g, '');
  const pages = fx.verifyPages.map((page) => compact(page.text).replace(/[.-]/g, '')).join('');

  for (const cpf of ALL_CPFS) {
    assert.ok(!pdf.includes(cpf), 'CPF completo no PDF');
    assert.ok(!pages.includes(cpf), 'CPF completo no /verificar');
  }
});

test('/verificar com cada código: "Concluído em", os três participantes e o hash do PDF final', opts, () => {
  assert.match(fx.hash.finalSha256, /^[0-9a-f]{64}$/);
  assert.equal(fx.hash.finalSha256, fx.signedSha256, 'hash final no banco ≠ PDF final baixado');

  const completedAt = brasilia(
    `${db(`select to_json("completedAt")#>>'{}' from "Envelope" where id = ${sql(fx.envelope.id)}`)}Z`,
  );

  for (const [index, page] of fx.verifyPages.entries()) {
    const who = fx.signers[index].key;

    assert.equal(page.status, 200, who);
    assert.ok(page.text.includes(fx.title), `título (${who})`);
    assert.ok(page.text.includes(`Concluído em ${completedAt} (horário de Brasília)`), `"Concluído em" (${who})`);
    assert.ok(page.text.includes('Participantes'), who);

    for (const signer of fx.signers) {
      assert.ok(page.text.includes(signer.hr.nome), `participante ${signer.key} (${who})`);
      assert.ok(page.text.includes(`CPF ${maskCpf(signer.person.cpf)}`), `CPF mascarado de ${signer.key} (${who})`);
      assert.ok(
        page.text.includes(`Assinou em ${brasilia(`${signer.proof.signedAt}Z`)} (horário de Brasília)`),
        `data de ${signer.key} (${who})`,
      );
      assert.ok(!page.text.includes(signer.email), `e-mail de ${signer.key} no /verificar`);
    }

    assert.ok(page.text.includes('SHA-256 do documento final'), who);
    assert.ok(page.text.includes(fx.hash.finalSha256), `hash final (${who})`);
    assert.equal(page.text.split('Assinou em').length - 1, 3, `três participantes (${who})`);
  }
});

test('selagem: pdfsig válido cobrindo o documento todo, DocMDP P=2 e política PAdES AD-RB', opts, () => {
  const line = (key) => fx.inspect.output.match(new RegExp(`^${key}: (.*)$`, 'm'))?.[1];

  assert.ok(fx.verify.ok, fx.verify.output);
  assert.match(fx.verify.output, /OK {4}assinatura íntegra/);
  assert.match(fx.verify.output, /OK {4}assinatura cobre o documento inteiro/);
  assert.ok(fx.pdf.pages > 1, 'certificado e log anexados');
  assert.ok(fx.inspect.ok, fx.inspect.output);
  assert.equal(line('DocMDP'), 'P=2', fx.inspect.output);
  assert.equal(line('Perms/DocMDP'), 'this-signature');
  assert.equal(line('signedAttrs DER order'), 'OK');
  assert.equal(line('CMS verify \\(openssl\\)'), 'OK');
  assert.ok(fx.inspect.output.includes('(1.2.840.113549.1.9.16.2.15)'), 'atributo sigPolicyId ausente');
  assert.ok(fx.inspect.output.includes(':2.16.76.1.7.1.11.1.3'), 'OID da política AD-RB v1.3 ausente');
  assert.ok(
    fx.inspect.output.includes(':http://politicas.icpbrasil.gov.br/PA_PAdES_AD_RB_v1_3.der'),
    'URI da política',
  );
});
