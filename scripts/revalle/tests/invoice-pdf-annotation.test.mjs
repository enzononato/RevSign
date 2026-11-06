// Conta e centro de custo escritos no PDF final da NF (revalle/docs/notas-fiscais.md, "No PDF final").
//   - NF com 2 signatários, aprovada: a página da nota tem "Conta: {código} - {nome}" e "CC: {código} - {nome}", cada
//     um uma vez, em azul, dentro da página e logo acima do carimbo da primeira assinatura (a de cima, não a do
//     primeiro destinatário); durante a retenção (prévia) e no original, nada; o SHA-256 do original não muda; a
//     assinatura digital segue válida e o /verificar lista o hash do original e do selado;
//   - reselagem pelo admin: o texto continua uma vez só;
//   - correção do centro e troca de conta: a v2 tem o novo e não o antigo;
//   - NF sem centro, NF sem conta (LEGACY), documento comum e NF recusada: só a linha que existe, ou nada;
//   - nome longo (quebra na margem), nome médio com campo à direita (recua), campo no alto (texto abaixo do campo),
//     página com rotação de 90 graus e documento V1: tudo dentro da página;
//   - falha ao desenhar (fonte indisponível, provocada de verdade no container): a NF é selada sem o texto, e o log
//     não traz dados da nota.
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN) e REVSIGN_ADMIN_* (rsadmin, marcado como Financeiro e
// Contabilidade aqui). Imagens: REVSIGN_UI_PDF_DIR (padrão: pasta temporária). Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { degrees, PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

import {
  APP_CONTAINER,
  appLogs,
  assertNoPaidGeminiCalls,
  BASE_URL,
  chooseInvoice,
  completeWithCode,
  createEnvelope,
  db,
  distribute,
  downloadItem,
  fetchIdempotent,
  poppler,
  retryCreateOnStaleSocket,
  signIn,
  trpc,
  trpcAs,
} from './helpers.mjs';

assertNoPaidGeminiCalls();

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const REASON = 'Conta de serviço, não de material.';
const MEDIUM_NAME = 'Manutenção e conservação de instalações';
const LONG_NAME =
  'Manutenção preventiva e corretiva de instalações prediais, equipamentos de refrigeração, geradores e sistemas de combate a incêndio';
const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
].join('\n');
const TEST_ACCOUNTS_CSV = [
  ACCOUNTS_CSV,
  `8.1.01;${MEDIUM_NAME};Conservação;pagar`,
  `8.1.02;${LONG_NAME};Manutenção;pagar`,
].join('\n');

const PAGE = { width: 595, height: 842 };
const MARGIN = 18;
const FIELD = { width: 30, height: 8 };
const UI_PDF_DIR = process.env.REVSIGN_UI_PDF_DIR ?? path.join(tmpdir(), 'revsign-ui-pdf');
const POPPLER_IMAGE = 'revsign-test-poppler:local';
const FONT_FILE = '/app/apps/remix/build/client/fonts/noto-sans.ttf';

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-conta-no-pdf-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userCookie;
let adminCookie;

const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);
const data = (res) => res.body?.result?.data?.json;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const count = (text, piece) => text.split(piece).length - 1;

const waitStatus = async (envelopeId, wanted, attempts = 45) => {
  for (let i = 0; i < attempts && status(envelopeId) !== wanted; i += 1) {
    await sleep(2000);
  }

  return status(envelopeId);
};

const html = (route) =>
  fetchIdempotent(`${BASE_URL}${route}`, {}, async (res) => ({ status: res.status, text: await res.text() }));

// DANFE fictício; `variant` muda o arquivo. `rotation`: /Rotate da página (o texto fica na orientação do arquivo).
const danfe = async (variant, { rotation = 0 } = {}) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const lines = [
    'DANFE - Documento Auxiliar da Nota Fiscal Eletrônica',
    'Nº 000.012.345   Série 001',
    'Chave de Acesso',
    '2924 1012 3456 7800 0195 5500 1000 0123 4511 2345 6784',
    `Referência do teste: conta no pdf ${variant} ${RUN}`,
    'Valor Total da Nota: R$ 150,00',
  ];
  let y = 800;

  for (const line of lines) {
    page.drawText(line, { x: 40, y, size: 10, font, color: rgb(0, 0, 0) });
    y -= 16;
  }

  if (rotation) {
    page.setRotation(degrees(rotation));
  }

  const file = path.join(tmp, `danfe-${variant}.pdf`);

  writeFileSync(file, Buffer.from(await doc.save()));

  return file;
};

const loadVersion = (envelopeId) => {
  const [secondaryId, title] = db(`select "secondaryId" || '|' || title from "Envelope" where id = '${envelopeId}'`)
    .split(/\|(.*)/s)
    .slice(0, 2);
  const recipients = db(
    `select r.id || '|' || r.token || '|' || r.email || '|' || coalesce((select f.id::text from "Field" f where f."recipientId" = r.id and f.type = 'SIGNATURE' limit 1), '-') from "Recipient" r where r."envelopeId" = '${envelopeId}' order by r.email`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, token, email, fieldId] = line.split('|');

      return { id: Number(id), token, email, fieldId: Number(fieldId) };
    });

  return {
    id: envelopeId,
    title,
    documentId: Number.parseInt(secondaryId.split('_')[1], 10),
    item: db(`select id from "EnvelopeItem" where "envelopeId" = '${envelopeId}' order by "order" limit 1`),
    recipients,
  };
};

// NF com um campo de assinatura por destinatário, nas posições dadas (% da página), enviada pela API v2.
const newInvoice = async (
  label,
  { fields = [{ positionX: 10, positionY: 80 }], code = '2.1.03', costCenter = '201', pdf } = {},
) => {
  const emails = fields.map((_, index) => `conta-pdf-${label}-${index + 1}-${RUN}@revalle.com.br`);
  const title = `[TESTE NF] conta no pdf ${label} ${RUN}`;
  const file = pdf ?? (await danfe(label));
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({
      recipients: emails.map((email, index) => ({
        email,
        fields: [{ type: 'SIGNATURE', page: 1, ...FIELD, ...fields[index] }],
      })),
      pdf: file,
      title,
    }),
  );

  assert.equal(created.status, 200, created.text);

  const chosen = await chooseInvoice({ cookie: userCookie, envelopeId: created.id, code, costCenter });

  assert.equal(chosen.status, 200, chosen.text);
  assert.equal((await distribute(created.id)).length, fields.length);

  return { ...loadVersion(created.id), file };
};

const newCommon = async (label) => {
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({
      recipients: [{ email: `conta-pdf-${label}-1-${RUN}@revalle.com.br` }],
      title: `[TESTE] conta no pdf ${label} ${RUN}`,
    }),
  );

  assert.equal(created.status, 200, created.text);
  await distribute(created.id);

  return loadVersion(created.id);
};

// NF marcada depois do envio, sem centro de custo.
const newInvoiceWithoutCenter = async (label) => {
  const doc = await newCommon(label);

  assert.equal(
    (await trpcAs(userCookie, 'mutation', 'revalle.invoice.markAsInvoice', { envelopeId: doc.id })).status,
    200,
  );
  assert.equal((await chooseInvoice({ cookie: userCookie, envelopeId: doc.id, costCenter: null })).status, 200);

  return doc;
};

// NF criada como documento v1 (`internalVersion = 1`), como o finance-proof faz.
const newV1Invoice = async (label) => {
  const email = `conta-pdf-${label}-1-${RUN}@revalle.com.br`;
  const file = await danfe(label);
  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title: `[TESTE NF] conta no pdf v1 ${label} ${RUN}`,
      meta: { distributionMethod: 'NONE' },
      recipients: [
        {
          email,
          name: 'Teste',
          role: 'SIGNER',
          fields: [{ type: 'SIGNATURE', pageNumber: 1, pageX: 10, pageY: 80, width: 30, height: 8 }],
        },
      ],
    }),
  );
  form.append('file', new File([readFileSync(file)], path.basename(file), { type: 'application/pdf' }));

  const res = await fetch(`${BASE_URL}/api/v2-beta/document/create`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` },
    body: form,
  });
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(db(`select "internalVersion" from "Envelope" where id = '${body.envelopeId}'`), '1');
  assert.equal(
    (await chooseInvoice({ cookie: userCookie, envelopeId: body.envelopeId, costCenter: '201' })).status,
    200,
  );

  const sent = await fetch(`${BASE_URL}/api/v1/documents/${body.id}/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sendEmail: false }),
  });

  assert.equal(sent.status, 200, await sent.text());

  return { ...loadVersion(body.envelopeId), file };
};

const gate = async (token) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

const isV1 = (doc) => db(`select "internalVersion" from "Envelope" where id = '${doc.id}'`) === '1';

const sign = async (doc, index) => {
  const recipient = doc.recipients[index];

  await gate(recipient.token);
  assert.equal((await html(`/sign/${recipient.token}`)).status, 200);

  const signed = isV1(doc)
    ? await trpc('field.signFieldWithToken', {
        token: recipient.token,
        fieldId: recipient.fieldId,
        value: 'Teste Digitado',
        isBase64: false,
      })
    : await trpc('envelope.field.sign', {
        token: recipient.token,
        fieldId: recipient.fieldId,
        fieldValue: { type: 'SIGNATURE', value: 'Teste Digitado' },
      });

  assert.equal(signed.status, 200, signed.text);

  const completion = await completeWithCode({
    token: recipient.token,
    documentId: doc.documentId,
    email: recipient.email,
  });

  assert.ok(completion.ok, completion.text);
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
};

const signAll = async (doc) => {
  for (let index = 0; index < doc.recipients.length; index += 1) {
    await sign(doc, index);
  }
};

const approve = async (doc) => {
  const approved = await trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', { envelopeId: doc.id });

  assert.equal(approved.status, 200, approved.text);
  assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');
};

// Assina, aprova e espera a selagem.
const finish = async (doc) => {
  await signAll(doc);
  assert.equal(status(doc.id), 'PENDING');
  await approve(doc);
};

// Palavras do PDF com posição (pdftotext -bbox), por página.
const parseBbox = (bbox) =>
  bbox
    .split('<page ')
    .slice(1)
    .map((chunk) => {
      const [, width, height] = chunk.match(/width="([\d.]+)" height="([\d.]+)"/);

      return {
        width: Number(width),
        height: Number(height),
        words: [
          ...chunk.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/word>/g),
        ].map(([, x, y, x2, y2, text]) => ({
          x: Number(x),
          y: Number(y),
          x2: Number(x2),
          y2: Number(y2),
          text: text.replaceAll('&amp;', '&').trim(),
        })),
      };
    });

// Poppler com a pasta gravável (a do `poppler` do helpers é só leitura), com o usuário atual como dono dos arquivos.
const popplerWritable = (dir, script) =>
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '-v',
      `${dir}:/pdf`,
      POPPLER_IMAGE,
      'sh',
      '-c',
      script,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

// Imagem PPM da página 1 (100 dpi): as medidas voltam em pontos, no sentido em que a página é vista.
const parsePpm = (ppm) => {
  const header = ppm
    .subarray(0, 30)
    .toString('latin1')
    .match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
  const width = Number(header[1]);
  const height = Number(header[2]);
  const scale = 100 / 72;
  // Azul do texto (#0070C0), com tolerância para o antisserrilhado.
  const isBlue = (x, y) => {
    const offset = header[0].length + (y * width + x) * 3;

    return ppm[offset + 2] - ppm[offset] > 90 && ppm[offset + 2] > 130 && ppm[offset + 1] > 50;
  };

  return {
    size: { width: width / scale, height: height / scale },
    // Pixels azuis dentro de uma caixa, em pontos.
    blue: (box) => {
      let found = 0;

      for (let y = Math.max(0, Math.floor(box.y * scale)); y < Math.min(height, Math.ceil(box.y2 * scale)); y += 1) {
        for (let x = Math.max(0, Math.floor(box.x * scale)); x < Math.min(width, Math.ceil(box.x2 * scale)); x += 1) {
          if (isBlue(x, y)) {
            found += 1;
          }
        }
      }

      return found;
    },
    // Caixa que cerca todo o azul da página, ou null.
    blueBounds: () => {
      const bounds = { x: Infinity, y: Infinity, x2: -Infinity, y2: -Infinity };

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (isBlue(x, y)) {
            bounds.x = Math.min(bounds.x, x / scale);
            bounds.y = Math.min(bounds.y, y / scale);
            bounds.x2 = Math.max(bounds.x2, (x + 1) / scale);
            bounds.y2 = Math.max(bounds.y2, (y + 1) / scale);
          }
        }
      }

      return Number.isFinite(bounds.x) ? bounds : null;
    },
  };
};

// O PDF selado de um documento: texto, palavras com posição e (opcional) a imagem da página 1.
const inspect = async (doc, { image = null, version = 'signed' } = {}) => {
  const bytes = await downloadItem(doc.item, version);
  const dir = mkdtempSync(path.join(tmp, 'selado-'));

  writeFileSync(path.join(dir, 'signed.pdf'), bytes);

  const [text, bbox] = poppler(
    dir,
    'pdftotext /pdf/signed.pdf - && echo @@@@ && pdftotext -bbox /pdf/signed.pdf -',
  ).split('@@@@');
  const pages = parseBbox(bbox);

  popplerWritable(dir, 'pdftoppm -r 100 -f 1 -l 1 -singlefile /pdf/signed.pdf /pdf/page');

  const ppm = readFileSync(path.join(dir, 'page.ppm'));

  if (image) {
    mkdirSync(UI_PDF_DIR, { recursive: true });
    popplerWritable(dir, 'pdftoppm -r 110 -f 1 -l 1 -singlefile -png /pdf/signed.pdf /pdf/page');
    writeFileSync(path.join(UI_PDF_DIR, image), readFileSync(path.join(dir, 'page.png')));
  }

  const find = (token) => pages.flatMap((p) => p.words).filter((word) => word.text === token);

  return {
    bytes,
    dir,
    flat: text.replace(/\s+/g, ' '),
    pages,
    page: pages[0],
    all: pages.flatMap((p) => p.words),
    conta: find('Conta:'),
    cc: find('CC:'),
    image: parsePpm(ppm),
  };
};

const fieldTop = (doc, positionY, page = PAGE) => (positionY / 100) * page.height;

const sessionTest = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie || !adminCookie) {
      t.skip('credenciais de sessão não informadas');

      return;
    }

    await fn(t);
  });

before(async () => {
  if (!user.email || !user.password || !admin.email || !admin.password) {
    return;
  }

  userCookie = await signIn(user.email, user.password);
  adminCookie = await signIn(admin.email, admin.password);

  const adminId = Number(db(`select id from "User" where email = '${admin.email}'`));

  assert.equal(
    (await trpcAs(adminCookie, 'mutation', 'revalle.finance.adminSetMember', { userId: adminId, member: true })).status,
    200,
  );
  assert.equal(
    (await trpcAs(adminCookie, 'mutation', 'revalle.accounting.adminSetMember', { userId: adminId, isMember: true }))
      .status,
    200,
  );
  db(`delete from "RevalleFinanceMember" where "userId" = (select id from "User" where email = '${user.email}')`);
  assert.equal(
    (await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: TEST_ACCOUNTS_CSV })).status,
    200,
  );
  db(`delete from "RateLimit" where action like 'revalle.invoice%'`);
});

after(async () => {
  if (adminCookie) {
    db(`delete from "RevalleAccountingMember" where "userId" = (select id from "User" where email = '${admin.email}')`);
    await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });
  }
});

beforeEach(() => {
  db('delete from "RateLimit"');
});

sessionTest(
  'NF com 2 signatários: conta e CC uma vez só, em azul, acima do carimbo da primeira assinatura; prévia e original sem o texto; assinatura válida; reselagem sem duplicar',
  async () => {
    // O campo do 2º destinatário está mais acima: é ele a "primeira assinatura".
    const topY = 50;
    const nf = await newInvoice('principal', {
      fields: [
        { positionX: 10, positionY: 80 },
        { positionX: 40, positionY: topY },
      ],
    });
    const originalSha = sha(readFileSync(nf.file));

    await signAll(nf);
    assert.equal(status(nf.id), 'PENDING');

    // Retida: a prévia (PDF atual do documento) e o original não têm o texto.
    const preview = await inspect(nf, { version: 'pending' });

    assert.equal(preview.conta.length + preview.cc.length, 0, 'a prévia já tem a conta ou o centro');
    assert.ok(!preview.flat.includes('Fornecedores'), 'a prévia tem o nome da conta');

    await approve(nf);

    const sealed = await inspect(nf, { image: 'v2-conta-cc.png' });
    const top = fieldTop(nf, topY);

    assert.equal(sealed.conta.length, 1, 'Conta: não aparece uma vez só no PDF todo');
    assert.equal(sealed.cc.length, 1, 'CC: não aparece uma vez só no PDF todo');
    assert.equal(sealed.page, sealed.pages[0]);
    assert.ok(sealed.page.words.includes(sealed.conta[0]), 'a conta não está na página da nota');
    assert.equal(count(sealed.flat, 'Conta: 2.1.03 - Fornecedores'), 1);
    assert.equal(count(sealed.flat, 'CC: 201 - Armazém'), 1);

    // Acima do carimbo da primeira assinatura (a de cima), na mesma coluna do campo, e a conta acima do CC.
    const [conta] = sealed.conta;
    const [cc] = sealed.cc;

    assert.ok(conta.y < cc.y, 'a conta deveria vir antes do centro');
    assert.ok(cc.y2 <= top + 0.5 && cc.y2 > top - 8, `o CC (${cc.y2}) não está logo acima do campo (${top})`);
    assert.ok(Math.abs(conta.x - 0.4 * PAGE.width) < 1, 'o texto não começa na esquerda do campo');

    const stampWords = sealed.page.words.filter((word) => word.text === 'Assinado');

    assert.equal(stampWords.length, 2, 'os dois carimbos deveriam estar na página');
    assert.ok(Math.min(...stampWords.map((word) => word.y)) >= cc.y2, 'o texto não está acima do carimbo de cima');

    // Em azul e só ali.
    const box = { x: conta.x, y: conta.y, x2: Math.max(conta.x2, cc.x2) + 120, y2: cc.y2 };

    assert.ok(sealed.image.blue(box) > 600, 'o texto não está inteiro em azul (glifos faltando?)');
    assert.equal(sealed.image.blue({ x: 0, y: top + 2, x2: PAGE.width, y2: PAGE.height }), 0, 'azul fora do texto');

    // Dentro da página.
    for (const word of [conta, cc]) {
      assert.ok(word.x >= MARGIN - 0.5 && word.x2 <= PAGE.width - MARGIN + 0.5);
    }

    // O original não muda (SHA-256 igual ao do arquivo enviado e ao do banco), e o selado é outro arquivo.
    const original = await downloadItem(nf.item, 'original');

    assert.equal(sha(original), originalSha, 'o original mudou');
    writeFileSync(path.join(sealed.dir, 'original.pdf'), original);
    assert.equal(
      db(`select "originalSha256" from "RevalleDocumentHash" where "envelopeItemId" = '${nf.item}'`),
      originalSha,
    );
    assert.notEqual(sha(sealed.bytes), originalSha);

    // Assinatura digital válida e /verificar com o original e o selado.
    const verified = execFileSync(
      'sh',
      [
        path.resolve('scripts/revalle/verify-signed-pdf.sh'),
        path.join(sealed.dir, 'signed.pdf'),
        path.join(sealed.dir, 'original.pdf'),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();

    assert.match(verified, /Signature is Valid/);

    db('delete from "RateLimit"');

    const code = db(
      `select "verificationCode" from "RevalleSignatureProof" where "recipientId" = ${nf.recipients[0].id}`,
    );
    const verify = (await html(`/verificar?codigo=${encodeURIComponent(code)}`)).text.replace(/<!-- -->/g, '');

    assert.ok(
      sealed.flat.replace(/\s/g, '').includes(`SHA-256dooriginal:${originalSha}`),
      'o certificado não traz o hash do original',
    );
    assert.ok(verify.includes(sha(sealed.bytes)), '/verificar sem o hash do arquivo selado');

    // Reselagem pelo admin: parte do PDF original, então o texto não duplica.
    const dataBefore = db(`select "documentDataId" from "EnvelopeItem" where id = '${nf.item}'`);
    const resealed = await trpcAs(adminCookie, 'mutation', 'admin.document.reseal', { id: nf.id });

    assert.ok(resealed.ok, resealed.text);

    for (
      let i = 0;
      i < 45 && db(`select "documentDataId" from "EnvelopeItem" where id = '${nf.item}'`) === dataBefore;
      i += 1
    ) {
      await sleep(1000);
    }

    assert.notEqual(db(`select "documentDataId" from "EnvelopeItem" where id = '${nf.item}'`), dataBefore);

    const again = await inspect(nf);

    assert.equal(again.conta.length, 1, 'a reselagem duplicou a conta');
    assert.equal(again.cc.length, 1, 'a reselagem duplicou o centro');
    assert.equal(count(again.flat, 'Conta: 2.1.03 - Fornecedores'), 1);
  },
);

sessionTest('correção do centro e troca de conta: a v2 traz o novo e não o antigo', async () => {
  // Centro: NF concluída com 101, a Contabilidade corrige para 201.
  const nf = await newInvoice('corrige-centro', { costCenter: '101' });

  await finish(nf);

  const first = await inspect(nf);

  assert.equal(count(first.flat, 'CC: 101 - Puxada'), 1);
  assert.equal(count(first.flat, 'Conta: 2.1.03 - Fornecedores'), 1);

  const corrected = await trpcAs(adminCookie, 'mutation', 'revalle.accounting.changeCostCenter', {
    envelopeId: nf.id,
    code: '201',
    reason: REASON,
  });

  assert.equal(corrected.status, 200, corrected.text);

  const v2 = loadVersion(data(corrected).newEnvelopeId);

  assert.equal(await waitStatus(v2.id, 'PENDING', 15), 'PENDING');
  await signAll(v2);
  assert.equal(await waitStatus(v2.id, 'COMPLETED'), 'COMPLETED');

  const sealedV2 = await inspect(v2);

  assert.equal(count(sealedV2.flat, 'CC: 201 - Armazém'), 1, 'a v2 não tem o centro novo');
  assert.equal(count(sealedV2.flat, 'Conta: 2.1.03 - Fornecedores'), 1);
  assert.ok(
    !sealedV2.page.words.some((word) => word.text === 'Puxada' || word.text === '101'),
    'a v2 tem o centro antigo',
  );

  // A versão anterior continua como foi selada.
  const old = await inspect(nf);

  assert.equal(count(old.flat, 'CC: 101 - Puxada'), 1);
  assert.equal(old.cc.length, 1);

  // Conta: NF concluída com 2.1.03, o Financeiro troca para 3.1.01.
  const nf2 = await newInvoice('troca-conta');

  await finish(nf2);

  const swapped = await trpcAs(adminCookie, 'mutation', 'revalle.finance.changeAccount', {
    envelopeId: nf2.id,
    code: '3.1.01',
    reason: REASON,
  });

  assert.equal(swapped.status, 200, swapped.text);

  const v2Account = loadVersion(data(swapped).newEnvelopeId);

  await signAll(v2Account);
  await approve(v2Account);

  const sealedAccount = await inspect(v2Account);

  assert.equal(count(sealedAccount.flat, 'Conta: 3.1.01 - Serviços de terceiros'), 1);
  assert.ok(
    !sealedAccount.page.words.some((word) => word.text === 'Fornecedores' || word.text === '2.1.03'),
    'a v2 tem a conta antiga',
  );
  assert.equal(count(sealedAccount.flat, 'CC: 201 - Armazém'), 1);
});

sessionTest('NF sem centro, NF sem conta, documento comum e NF recusada: só a linha que existe, ou nada', async () => {
  // Sem centro (marcada depois do envio): só a conta.
  const noCenter = await newInvoiceWithoutCenter('sem-centro');

  await finish(noCenter);

  const onlyAccount = await inspect(noCenter);

  assert.equal(count(onlyAccount.flat, 'Conta: 2.1.03 - Fornecedores'), 1);
  assert.equal(onlyAccount.cc.length, 0, 'NF sem centro com a linha CC');

  // Sem conta (LEGACY, sem aprovação): só o centro, mesmo com a conta escolhida gravada.
  const legacy = await newInvoice('legacy', { costCenter: '301' });

  db(`update "RevalleInvoiceClassification" set "financeStatus" = 'LEGACY' where "envelopeId" = '${legacy.id}'`);
  await signAll(legacy);
  assert.equal(await waitStatus(legacy.id, 'COMPLETED'), 'COMPLETED');

  const onlyCenter = await inspect(legacy);

  assert.equal(count(onlyCenter.flat, 'CC: 301 - Administrativo'), 1);
  assert.equal(onlyCenter.conta.length, 0, 'NF sem conta com a linha Conta');

  // Documento comum: nada.
  const common = await newCommon('comum');

  await sign(common, 0);
  assert.equal(await waitStatus(common.id, 'COMPLETED'), 'COMPLETED');

  const plain = await inspect(common);

  assert.equal(plain.conta.length + plain.cc.length, 0, 'documento comum com conta ou centro');

  // NF recusada: o primeiro assina, o segundo recusa. Nada.
  const refused = await newInvoice('recusada', {
    fields: [
      { positionX: 10, positionY: 80 },
      { positionX: 10, positionY: 60 },
    ],
  });

  await sign(refused, 0);
  await gate(refused.recipients[1].token);

  const refusal = await trpc('recipient.rejectDocumentWithToken', {
    token: refused.recipients[1].token,
    documentId: refused.documentId,
    reason: 'Teste',
  });

  assert.equal(refusal.status, 200, refusal.text);
  assert.equal(await waitStatus(refused.id, 'REJECTED'), 'REJECTED');

  const rejected = await inspect(refused);

  assert.equal(rejected.conta.length + rejected.cc.length, 0, 'NF recusada com conta ou centro');
});

sessionTest('nome longo quebra dentro da margem; nome médio com campo à direita recua para a esquerda', async () => {
  // Nome longo, campo à esquerda: várias linhas, todas dentro da margem de 18 pt.
  const long = await newInvoice('nome-longo', { code: '8.1.02', fields: [{ positionX: 10, positionY: 50 }] });

  await finish(long);

  const wrapped = await inspect(long);
  const accountWords = LONG_NAME.split(' ');
  const lineYs = new Set(
    wrapped.page.words
      .filter((word) => accountWords.includes(word.text) && word.y < fieldTop(long, 50))
      .map((word) => Math.round(word.y)),
  );

  assert.ok(lineYs.size >= 2, 'o nome longo não quebrou em mais de uma linha');
  assert.equal(count(wrapped.flat, `Conta: 8.1.02 - ${LONG_NAME}`), 1);

  for (const word of wrapped.page.words) {
    assert.ok(word.x >= MARGIN - 0.5 && word.x2 <= PAGE.width - MARGIN + 0.5, `"${word.text}" fora da margem`);
  }

  // Nome médio, campo a 65% da largura: o texto não cabe a partir do campo e recua para a esquerda.
  const right = await newInvoice('campo-direita', { code: '8.1.01', fields: [{ positionX: 65, positionY: 50 }] });

  await finish(right);

  const slid = await inspect(right);
  const [conta] = slid.conta;
  const fieldX = 0.65 * PAGE.width;
  const accountEnd = Math.max(
    ...slid.page.words
      .filter((word) => MEDIUM_NAME.split(' ').includes(word.text) && word.y < fieldTop(right, 50))
      .map((word) => word.x2),
  );

  assert.ok(conta.x < fieldX - 20, `o texto não recuou (começa em ${conta.x})`);
  assert.ok(accountEnd <= PAGE.width - MARGIN + 0.5, 'o texto passou da margem direita');
  assert.equal(count(slid.flat, `Conta: 8.1.01 - ${MEDIUM_NAME}`), 1);
});

sessionTest('campo no alto da página: o texto vai abaixo do campo e fica dentro da página', async () => {
  const topY = 0.5;
  const nf = await newInvoice('campo-alto', { code: '8.1.02', fields: [{ positionX: 10, positionY: topY }] });

  await finish(nf);

  const sealed = await inspect(nf, { image: 'campo-no-alto.png' });
  const fieldBottom = ((topY + FIELD.height) / 100) * PAGE.height;

  assert.equal(sealed.conta.length, 1);
  assert.equal(sealed.cc.length, 1);
  assert.ok(
    sealed.conta[0].y >= fieldBottom - 0.5,
    `o texto (${sealed.conta[0].y}) não ficou abaixo do campo (${fieldBottom})`,
  );
  assert.ok(sealed.cc.at(0).y2 <= PAGE.height - MARGIN + 0.5);
  assert.ok(
    sealed.image.blue({ x: 0, y: fieldBottom, x2: PAGE.width, y2: PAGE.height }) > 900,
    'sem texto azul abaixo do campo',
  );

  for (const word of sealed.page.words) {
    assert.ok(word.x >= MARGIN - 0.5 && word.x2 <= PAGE.width - MARGIN + 0.5, `"${word.text}" fora da margem`);
    assert.ok(word.y >= 0 && word.y2 <= PAGE.height, `"${word.text}" fora da página`);
  }
});

sessionTest(
  'página com rotação de 90 graus e documento V1: o texto sai na orientação da página, acima do carimbo',
  async () => {
    const rotated = await newInvoice('rotacionada', {
      fields: [{ positionX: 20, positionY: 50 }],
      pdf: await danfe('rotacionada', { rotation: 90 }),
    });

    await finish(rotated);

    const sealed = await inspect(rotated, { image: 'rotacao-90.png' });
    const view = sealed.image.size;
    const top = fieldTop(rotated, 50, view);
    const blueBox = sealed.image.blueBounds();

    assert.ok(
      Math.abs(view.width - 842) < 1 && Math.abs(view.height - 595) < 1,
      'a página não saiu na orientação rotacionada',
    );
    assert.equal(sealed.conta.length, 1);
    assert.equal(sealed.cc.length, 1);
    assert.equal(count(sealed.flat, 'Conta: 2.1.03 - Fornecedores'), 1);
    assert.ok(blueBox, 'sem texto azul na página');
    assert.ok(sealed.image.blue(blueBox) > 600, 'glifos faltando no texto azul');
    assert.ok(
      blueBox.y2 <= top + 1 && blueBox.y2 > top - 10,
      `o texto (${blueBox.y2}) não está acima do campo (${top})`,
    );
    assert.ok(Math.abs(blueBox.x - 0.2 * view.width) < 3, `o texto começa em ${blueBox.x}, não na esquerda do campo`);
    assert.ok(blueBox.x2 < view.width - MARGIN + 1);

    const v1 = await newV1Invoice('v1');

    await finish(v1);

    const sealedV1 = await inspect(v1);

    assert.equal(count(sealedV1.flat, 'Conta: 2.1.03 - Fornecedores'), 1);
    assert.equal(count(sealedV1.flat, 'CC: 201 - Armazém'), 1);
    assert.ok(sealedV1.cc[0].y2 <= 0.8 * PAGE.height + 0.5);
  },
);

sessionTest(
  'falha ao desenhar (fonte indisponível): a NF é selada sem o texto e o log não traz dados da nota',
  async () => {
    const nf = await newInvoice('falha');

    await signAll(nf);

    const logsBefore = appLogs().length;

    execFileSync('docker', ['exec', '-u', 'root', APP_CONTAINER, 'mv', FONT_FILE, `${FONT_FILE}.off`]);

    try {
      await approve(nf);
    } finally {
      execFileSync('docker', ['exec', '-u', 'root', APP_CONTAINER, 'mv', `${FONT_FILE}.off`, FONT_FILE]);
    }

    const sealed = await inspect(nf);

    assert.ok(sealed.flat.includes('Certificado de Assinatura'), 'a NF não foi selada com o certificado');
    assert.equal(sealed.conta.length + sealed.cc.length, 0, 'o texto saiu sem a fonte');
    assert.ok(
      sealed.page.words.some((word) => word.text === 'Assinado'),
      'o carimbo sumiu',
    );

    const logs = appLogs().slice(logsBefore);

    assert.ok(logs.includes('revalle invoice annotation'), 'a falha não foi registrada');
    assert.ok(!logs.includes('Fornecedores') && !logs.includes('Armazém'), 'o log tem dados da nota');
  },
);
