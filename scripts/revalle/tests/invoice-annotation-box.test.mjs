// Conta e centro de custo no PDF final só onde o remetente põe o bloco "Conta e centro de custo" (spec
// 2026-11-17-conta-cc-posicionavel): por padrão nada é escrito; com bloco numa nota, o texto azul sai dentro do bloco, na
// página escolhida; bloco em contrato ou boleto não sai; a nova versão copia o bloco e a marca de envio antigo
// (`autoAnnotation`); o envio de antes da atualização mantém o texto automático acima da assinatura; o bloco só muda no
// rascunho, pelo envelope e por quem edita; página que não existe mais e arquivo trocado não derrubam nada; a migração
// marca só o que já tinha saído do rascunho (ou era nova versão).
// Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN) e REVSIGN_ADMIN_* (rsadmin, marcado como Financeiro aqui), mais
// uma conta de teste nova (account-helpers.mjs) para o "outro usuário". Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, beforeEach, test } from 'node:test';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

import './account-autologin.mjs'; // conta obrigatória (16/11/2026): entra na conta de quem assina pelo e-mail da empresa
import { sessionFor } from './account-helpers.mjs';
import {
  api,
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
  invoicePdfFile,
  markAutoAnnotation,
  poppler,
  retryCreateOnStaleSocket,
  setAnnotationBox,
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
// A lista de contas padrão dos testes (a que invoice-pdf-annotation.test.mjs devolve no fim).
const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
].join('\n');
const PAGE = { width: 595, height: 842 };
const FIELD = { width: 30, height: 8 };
const BOX = { page: 1, positionX: 10, positionY: 40, width: 45, height: 6 };
const MIGRATION = path.resolve('packages/prisma/migrations/20261117100000_revalle_annotation_box/migration.sql');

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-bloco-conta-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userCookie;
let adminCookie;

const status = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);
const data = (res) => res.body?.result?.data?.json;
const count = (text, piece) => text.split(piece).length - 1;
const teamHeader = (envelopeId) => ({ 'x-team-id': db(`select "teamId" from "Envelope" where id = '${envelopeId}'`) });
const autoAnnotation = (envelopeId) =>
  db(`select "autoAnnotation" from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`);
const boxRow = (envelopeItemId) =>
  db(
    `select page || '|' || "positionX" || '|' || "positionY" || '|' || width || '|' || height from "RevalleInvoiceAnnotationBox" where "envelopeItemId" = '${envelopeItemId}'`,
  );
const rectRow = (rect) => [rect.page, rect.positionX, rect.positionY, rect.width, rect.height].join('|');

const waitStatus = async (envelopeId, wanted, attempts = 45) => {
  for (let i = 0; i < attempts && status(envelopeId) !== wanted; i += 1) {
    await sleep(2000);
  }

  return status(envelopeId);
};

const html = (route) =>
  fetchIdempotent(`${BASE_URL}${route}`, {}, async (res) => ({ status: res.status, text: await res.text() }));

// DANFE fictício com `pages` páginas (o texto da nota na 1ª); `variant` muda o arquivo.
const danfe = async (variant, { pages = 1 } = {}) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [
    'DANFE - Documento Auxiliar da Nota Fiscal Eletrônica',
    'Nº 000.012.345   Série 001',
    'Chave de Acesso',
    '2924 1012 3456 7800 0195 5500 1000 0123 4511 2345 6784',
    `Referência do teste: bloco de conta ${variant} ${RUN}`,
    'Valor Total da Nota: R$ 150,00',
  ];

  for (let index = 0; index < pages; index += 1) {
    const page = doc.addPage([PAGE.width, PAGE.height]);
    let y = 800;

    for (const line of index === 0 ? lines : [`Continuação da nota, página ${index + 1}`]) {
      page.drawText(line, { x: 40, y, size: 10, font, color: rgb(0, 0, 0) });
      y -= 16;
    }
  }

  const file = path.join(tmp, `danfe-${variant}.pdf`);

  writeFileSync(file, Buffer.from(await doc.save()));

  return file;
};

const loadVersion = (envelopeId) => {
  const secondaryId = db(`select "secondaryId" from "Envelope" where id = '${envelopeId}'`);
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
    documentId: Number.parseInt(secondaryId.split('_')[1], 10),
    item: db(`select id from "EnvelopeItem" where "envelopeId" = '${envelopeId}' order by "order" limit 1`),
    recipients,
  };
};

// NF de um arquivo em rascunho, com um campo de assinatura (`fieldY`, % da página) e a conta e o centro escolhidos.
const newDraftInvoice = async (label, { pages = 1, fieldY = 80 } = {}) => {
  const pdf = await danfe(label, { pages });
  const created = await retryCreateOnStaleSocket(() =>
    createEnvelope({
      recipients: [
        {
          email: `bloco-conta-${label}-${RUN}@revalle.com.br`,
          fields: [{ type: 'SIGNATURE', page: 1, positionX: 10, positionY: fieldY, ...FIELD }],
        },
      ],
      pdf,
      title: `[TESTE NF] bloco de conta ${label} ${RUN}`,
    }),
  );

  assert.equal(created.status, 200, created.text);

  const chosen = await chooseInvoice({ cookie: userCookie, envelopeId: created.id, costCenter: '201' });

  assert.equal(chosen.status, 200, chosen.text);

  return loadVersion(created.id);
};

// A NF enviada: com o bloco `box` (opcional) e, com `auto`, marcada como envio de antes da atualização.
const newInvoice = async (label, { box = null, auto = false, pages = 1, fieldY = 80 } = {}) => {
  const draft = await newDraftInvoice(label, { pages, fieldY });

  if (box) {
    const placed = await setAnnotationBox({
      cookie: userCookie,
      envelopeId: draft.id,
      envelopeItemId: draft.item,
      rect: box,
    });

    assert.equal(placed.status, 200, placed.text);
  }

  assert.equal((await distribute(draft.id)).length, 1);

  if (auto) {
    markAutoAnnotation(draft.id);
  }

  return loadVersion(draft.id);
};

const gate = async (token) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

// O único signatário assina todos os campos de assinatura dele (um por arquivo) e conclui.
const signAll = async (doc) => {
  const [recipient] = doc.recipients;
  const fields = db(`select id from "Field" where "recipientId" = ${recipient.id} and type = 'SIGNATURE' order by id`)
    .split('\n')
    .filter(Boolean)
    .map(Number);

  await gate(recipient.token);
  assert.equal((await html(`/sign/${recipient.token}`)).status, 200);

  for (const fieldId of fields) {
    const signed = await trpc('envelope.field.sign', {
      token: recipient.token,
      fieldId,
      fieldValue: { type: 'SIGNATURE', value: 'Teste Digitado' },
    });

    assert.equal(signed.status, 200, signed.text);
  }

  const completion = await completeWithCode({
    token: recipient.token,
    documentId: doc.documentId,
    email: recipient.email,
  });

  assert.ok(completion.ok, completion.text);
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
};

const approve = async (envelopeId, envelopeItemId) => {
  const approved = await trpcAs(adminCookie, 'mutation', 'revalle.finance.approve', {
    envelopeId,
    ...(envelopeItemId ? { envelopeItemId } : {}),
  });

  assert.equal(approved.status, 200, approved.text);
};

// Assina, aprova e espera a selagem.
const finish = async (doc) => {
  await signAll(doc);
  assert.equal(status(doc.id), 'PENDING');
  await approve(doc.id);
  assert.equal(await waitStatus(doc.id, 'COMPLETED'), 'COMPLETED');
};

// O arquivo selado: o texto todo e as palavras com posição (pdftotext -bbox), por página (a 1ª é a 1).
const inspect = async (itemId) => {
  const dir = mkdtempSync(path.join(tmp, 'selado-'));

  writeFileSync(path.join(dir, 'signed.pdf'), await downloadItem(itemId, 'signed'));

  const [text, bbox] = poppler(
    dir,
    'pdftotext /pdf/signed.pdf - && echo @@@@ && pdftotext -bbox /pdf/signed.pdf -',
  ).split('@@@@');
  const pages = bbox
    .split('<page ')
    .slice(1)
    .map((chunk) =>
      [...chunk.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/word>/g)].map(
        ([, x, y, x2, y2, word]) => ({
          x: Number(x),
          y: Number(y),
          x2: Number(x2),
          y2: Number(y2),
          text: word.replaceAll('&amp;', '&').trim(),
        }),
      ),
    );
  const find = (token) =>
    pages.flatMap((words, index) =>
      words.filter((word) => word.text === token).map((word) => ({ ...word, page: index + 1 })),
    );

  return { flat: text.replace(/\s+/g, ' '), pages, conta: find('Conta:'), cc: find('CC:') };
};

// O retângulo do bloco em pt, origem no topo-esquerda (como o pdftotext -bbox), numa página A4.
const boxPt = (rect) => ({
  x: (rect.positionX / 100) * PAGE.width,
  y: (rect.positionY / 100) * PAGE.height,
  x2: ((rect.positionX + rect.width) / 100) * PAGE.width,
  y2: ((rect.positionY + rect.height) / 100) * PAGE.height,
});

const assertInside = (word, rect, label) => {
  const box = boxPt(rect);

  assert.ok(
    word.x >= box.x - 1 && word.x2 <= box.x2 + 1 && word.y >= box.y - 1 && word.y2 <= box.y2 + 1,
    `${label} (${word.x}, ${word.y}, ${word.x2}, ${word.y2}) fora do bloco (${box.x}, ${box.y}, ${box.x2}, ${box.y2})`,
  );
};

// Envelope (API v2) com vários arquivos e um campo de assinatura do signatário em cada (o envio exige).
const newMultiFile = async (files, label) => {
  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title: `[TESTE NF] bloco de conta ${label} ${RUN}`,
      type: 'DOCUMENT',
      meta: { distributionMethod: 'NONE' },
      recipients: [
        {
          role: 'SIGNER',
          name: 'Teste',
          email: `bloco-conta-${label}-${RUN}@revalle.com.br`,
          fields: files.map((_, identifier) => ({
            type: 'SIGNATURE',
            identifier,
            page: 1,
            positionX: 10,
            positionY: 80,
            ...FIELD,
          })),
        },
      ],
    }),
  );

  for (const file of files) {
    form.append('files', new File([readFileSync(file)], path.basename(file), { type: 'application/pdf' }));
  }

  const created = await retryCreateOnStaleSocket(async () => {
    const res = await fetch(`${BASE_URL}/api/v2-beta/envelope/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` },
      body: form,
    });

    return { status: res.status, body: await res.json() };
  });

  assert.equal(created.status, 200, JSON.stringify(created.body));

  const envelope = (await api('GET', `/envelope/${created.body.id}`)).body;

  return {
    id: created.body.id,
    items: Object.fromEntries(envelope.envelopeItems.map((item) => [item.title, item.id])),
  };
};

// Um envio com contrato, nf-a, boleto e nf-b; o bloco no contrato, no boleto e só na nf-a. O estado do rascunho fica
// guardado; o envio é assinado, as duas notas aprovadas, e ele é selado. Uma vez para os dois casos que o usam.
let multiFixture;

const sealedMulti = () => {
  multiFixture ??= (async () => {
    const contractFile = path.join(mkdtempSync(path.join(tmp, 'c-')), 'contrato.pdf');

    copyFileSync('assets/example.pdf', contractFile);

    const env = await newMultiFile(
      [
        contractFile,
        invoicePdfFile({ variant: `nf-a-bloco-${RUN}` }),
        invoicePdfFile({ variant: `boleto-bloco-${RUN}` }),
        invoicePdfFile({ variant: `nf-b-bloco-${RUN}` }),
      ],
      'varias',
    );
    const item = (prefix) => env.items[Object.keys(env.items).find((title) => title.startsWith(prefix))];
    const mutate = async (name, input) => {
      const res = await trpcAs(userCookie, 'mutation', `revalle.invoice.${name}`, { envelopeId: env.id, ...input });

      assert.equal(res.status, 200, res.text);

      return data(res);
    };

    await mutate('classify', {});
    await mutate('setFileKind', { envelopeItemId: item('boleto'), kind: 'BOLETO' });

    for (const [prefix, code, costCenter] of [
      ['nf-a', '2.1.03', '101'],
      ['nf-b', '3.1.01', '201'],
    ]) {
      await mutate('setChoice', { envelopeItemId: item(prefix), choice: { code } });
      await mutate('setCostCenter', { envelopeItemId: item(prefix), code: costCenter });
    }

    for (const prefix of ['contrato', 'boleto', 'nf-a']) {
      const placed = await setAnnotationBox({ cookie: userCookie, envelopeId: env.id, envelopeItemId: item(prefix) });

      assert.equal(placed.status, 200, placed.text);
    }

    const draftState = data(await trpcAs(userCookie, 'query', 'revalle.invoice.get', { envelopeId: env.id }));

    assert.equal((await distribute(env.id)).length, 1);

    const doc = loadVersion(env.id);

    await signAll(doc);
    assert.equal(status(env.id), 'PENDING');

    for (const prefix of ['nf-a', 'nf-b']) {
      await approve(env.id, item(prefix));
    }

    assert.equal(await waitStatus(env.id, 'COMPLETED'), 'COMPLETED');

    return { env, item, draftState };
  })();

  return multiFixture;
};

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
  db(`delete from "RevalleFinanceMember" where "userId" = (select id from "User" where email = '${user.email}')`);
  assert.equal(
    (await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV })).status,
    200,
  );
  db(`delete from "RateLimit" where action like 'revalle.invoice%'`);
});

beforeEach(() => {
  db('delete from "RateLimit"');
});

// O PDF do arquivo do rascunho trocado pelo editor (`envelope.item.replacePdf`, multipart como a tela manda).
const replacePdf = async ({ envelopeId, envelopeItemId, file }) => {
  const form = new FormData();

  form.append('payload', JSON.stringify({ envelopeId, envelopeItemId }));
  form.append('file', new File([readFileSync(file)], path.basename(file), { type: 'application/pdf' }));

  const res = await fetch(`${BASE_URL}/api/trpc/envelope.item.replacePdf`, {
    method: 'POST',
    headers: { Origin: new URL(BASE_URL).origin, Cookie: userCookie, ...teamHeader(envelopeId) },
    body: form,
  });

  return { status: res.status, text: await res.text() };
};

// SQL pela entrada do psql (cada comando com a sua saída), numa chamada só.
const psql = (input) =>
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'revsign-hml-database-1',
      'psql',
      '-U',
      'documenso',
      '-d',
      'documenso',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
    ],
    { input, encoding: 'utf8' },
  );

const boxRoute = (cookie, kind, name, input, headers) =>
  trpcAs(cookie, kind, `revalle.invoice.annotationBox.${name}`, input, headers);

sessionTest('sem bloco: a nota selada sai sem Conta: nem CC:', async () => {
  const nf = await newInvoice('sem-bloco');

  await finish(nf);

  const sealed = await inspect(nf.item);

  assert.equal(sealed.conta.length + sealed.cc.length, 0, 'a nota sem bloco recebeu Conta: ou CC:');
  assert.ok(!sealed.flat.includes('2.1.03 - Fornecedores'), 'a linha da conta saiu sem bloco');
  assert.ok(sealed.flat.includes('Certificado de Assinatura'), 'a nota não foi selada');
});

sessionTest('com bloco: o texto sai dentro do bloco, na página escolhida', async () => {
  const rect = { page: 2, positionX: 10, positionY: 70, width: 45, height: 6 };
  const nf = await newInvoice('pagina-2', { box: rect, pages: 2 });

  assert.equal(boxRow(nf.item), rectRow(rect));

  await finish(nf);

  const sealed = await inspect(nf.item);

  assert.equal(sealed.conta.length, 1, 'Conta: não aparece uma vez só');
  assert.equal(sealed.cc.length, 1, 'CC: não aparece uma vez só');
  assert.equal(count(sealed.flat, 'Conta: 2.1.03 - Fornecedores'), 1);
  assert.equal(count(sealed.flat, 'CC: 201 - Armazém'), 1);

  const [conta] = sealed.conta;
  const [cc] = sealed.cc;

  assert.equal(conta.page, 2, 'a conta não está na página 2');
  assert.equal(cc.page, 2, 'o centro não está na página 2');
  assert.ok(conta.y < cc.y, 'a conta deveria vir antes do centro');
  assertInside(conta, rect, 'Conta:');
  assertInside(cc, rect, 'CC:');

  // Alinhado ao alto e à esquerda do bloco.
  const box = boxPt(rect);

  assert.ok(conta.x - box.x < 4, `o texto começa em ${conta.x}, longe da esquerda do bloco (${box.x})`);
  assert.ok(conta.y - box.y < 4, `o texto começa em ${conta.y}, longe do alto do bloco (${box.y})`);

  // As palavras da linha da conta e do centro, todas dentro do bloco.
  const lineWords = new Set(['Conta:', '2.1.03', '-', 'Fornecedores', 'CC:', '201', 'Armazém']);

  for (const word of sealed.pages[1].filter((candidate) => lineWords.has(candidate.text))) {
    assertInside(word, rect, word.text);
  }
});

sessionTest('bloco em contrato e em boleto não sai; o estado lista o bloco', async () => {
  const { item, draftState } = await sealedMulti();

  assert.equal(draftState.autoAnnotation, false);
  assert.deepEqual(
    [...draftState.annotationBoxes].sort((a, b) => a.envelopeItemId.localeCompare(b.envelopeItemId)),
    [
      { envelopeItemId: item('contrato'), page: 1 },
      { envelopeItemId: item('boleto'), page: 1 },
      { envelopeItemId: item('nf-a'), page: 1 },
    ].sort((a, b) => a.envelopeItemId.localeCompare(b.envelopeItemId)),
  );
  // O bloco é aceito em qualquer arquivo; o tipo de cada um decide se ele é impresso.
  const kinds = Object.fromEntries(draftState.documents.map((document) => [document.envelopeItemId, document.kind]));

  assert.equal(kinds[item('nf-a')], 'NF');
  assert.equal(kinds[item('nf-b')], 'NF');
  assert.equal(kinds[item('boleto')], 'BOLETO');
  assert.notEqual(kinds[item('contrato')], 'NF');

  for (const prefix of ['contrato', 'boleto']) {
    const sealed = await inspect(item(prefix));

    assert.equal(sealed.conta.length + sealed.cc.length, 0, `${prefix} recebeu Conta: ou CC:`);
  }
});

sessionTest('duas notas, um bloco: só aquela nota recebe o texto', async () => {
  const { item } = await sealedMulti();
  const a = await inspect(item('nf-a'));
  const b = await inspect(item('nf-b'));

  assert.equal(count(a.flat, 'Conta: 2.1.03 - Fornecedores'), 1);
  assert.equal(count(a.flat, 'CC: 101 - Puxada'), 1);
  assert.equal(a.conta.length, 1);
  assertInside(a.conta[0], BOX, 'Conta: da nf-a');
  assertInside(a.cc[0], BOX, 'CC: da nf-a');
  assert.equal(b.conta.length + b.cc.length, 0, 'a nf-b, sem bloco, recebeu Conta: ou CC:');
});

sessionTest('nova versão copia o bloco e o autoAnnotation', async () => {
  const rect = { page: 1, positionX: 30, positionY: 20, width: 40, height: 7 };

  for (const auto of [false, true]) {
    const nf = await newInvoice(auto ? 'versao-antiga' : 'versao-nova', { box: rect, auto });

    assert.equal(autoAnnotation(nf.id), auto ? 't' : 'f');

    const swapped = await trpcAs(adminCookie, 'mutation', 'revalle.finance.changeAccount', {
      envelopeId: nf.id,
      code: '3.1.01',
      reason: REASON,
    });

    assert.equal(swapped.status, 200, swapped.text);

    const v2 = loadVersion(data(swapped).newEnvelopeId);

    assert.notEqual(v2.item, nf.item);
    assert.equal(boxRow(v2.item), rectRow(rect), 'a nova versão não copiou o bloco na mesma posição');
    assert.equal(boxRow(nf.item), rectRow(rect), 'a versão antiga perdeu o bloco');
    assert.equal(autoAnnotation(v2.id), auto ? 't' : 'f', 'a nova versão não herdou a marca de envio antigo');
  }

  // Duplicar (cópia comum do usuário) copia o bloco, mas não a marca de envio antigo.
  const draft = await newDraftInvoice('duplicar');

  assert.equal(
    (await setAnnotationBox({ cookie: userCookie, envelopeId: draft.id, envelopeItemId: draft.item })).status,
    200,
  );

  const duplicated = await trpcAs(
    userCookie,
    'mutation',
    'envelope.duplicate',
    { envelopeId: draft.id },
    teamHeader(draft.id),
  );

  assert.equal(duplicated.status, 200, duplicated.text);

  const copyId = data(duplicated).id;
  const copyItem = db(`select id from "EnvelopeItem" where "envelopeId" = '${copyId}'`);

  assert.equal(boxRow(copyItem), rectRow(BOX), 'duplicar não copiou o bloco');
  assert.notEqual(autoAnnotation(copyId), 't');
});

sessionTest('envio de antes da atualização: texto automático acima da assinatura', async () => {
  // O bloco existe, mas no envio antigo não vale: o texto vai acima do campo, como antes.
  const fieldY = 60;
  const nf = await newInvoice('antigo', {
    box: { page: 1, positionX: 50, positionY: 5, width: 40, height: 6 },
    auto: true,
    fieldY,
  });

  await finish(nf);

  const sealed = await inspect(nf.item);
  const top = (fieldY / 100) * PAGE.height;
  const [conta] = sealed.conta;
  const [cc] = sealed.cc;

  assert.equal(sealed.conta.length, 1);
  assert.equal(sealed.cc.length, 1);
  assert.equal(count(sealed.flat, 'Conta: 2.1.03 - Fornecedores'), 1);
  assert.ok(conta.y < cc.y, 'a conta deveria vir antes do centro');
  assert.ok(cc.y2 <= top + 0.5 && cc.y2 > top - 8, `o CC (${cc.y2}) não está logo acima do campo (${top})`);
  assert.ok(Math.abs(conta.x - 0.1 * PAGE.width) < 1, 'o texto não começa na esquerda do campo');
});

sessionTest('bloco: só no rascunho, só do envio, só de quem edita', async () => {
  const draft = await newDraftInvoice('regras');
  const other = await newDraftInvoice('regras-outro');
  const headers = teamHeader(draft.id);

  // Fora da página e pequeno demais: volta para dentro, com o tamanho mínimo.
  const clamped = await boxRoute(
    userCookie,
    'mutation',
    'set',
    {
      envelopeId: draft.id,
      envelopeItemId: draft.item,
      rect: { page: 1, positionX: 95, positionY: 98, width: 30, height: 1 },
    },
    headers,
  );

  assert.equal(clamped.status, 200, clamped.text);
  assert.deepEqual(data(clamped), { page: 1, positionX: 70, positionY: 97, width: 30, height: 3 });

  const found = await boxRoute(userCookie, 'query', 'find', { envelopeId: draft.id }, headers);

  assert.equal(found.status, 200, found.text);
  assert.deepEqual(data(found).boxes, [
    { envelopeItemId: draft.item, page: 1, positionX: 70, positionY: 97, width: 30, height: 3 },
  ]);

  // O arquivo de outro envelope: 404, e nada gravado.
  const foreignItem = await boxRoute(
    userCookie,
    'mutation',
    'set',
    { envelopeId: draft.id, envelopeItemId: other.item, rect: BOX },
    headers,
  );

  assert.equal(foreignItem.status, 404, foreignItem.text);
  assert.equal(boxRow(other.item), '');

  // Outro usuário (fora do time do envelope): 404 em tudo.
  const stranger = await sessionFor(`bloco-conta-estranho-${RUN}@revalle.com.br`);

  for (const [kind, name, input] of [
    ['mutation', 'set', { envelopeId: draft.id, envelopeItemId: draft.item, rect: BOX }],
    ['mutation', 'delete', { envelopeId: draft.id, envelopeItemId: draft.item }],
    ['query', 'find', { envelopeId: draft.id }],
  ]) {
    const res = await boxRoute(stranger, kind, name, input, headers);

    assert.equal(res.status, 404, `${name}: ${res.text}`);
  }

  assert.equal(boxRow(draft.item), rectRow({ page: 1, positionX: 70, positionY: 97, width: 30, height: 3 }));

  // Tirar o bloco.
  const removed = await boxRoute(
    userCookie,
    'mutation',
    'delete',
    { envelopeId: draft.id, envelopeItemId: draft.item },
    headers,
  );

  assert.equal(removed.status, 200, removed.text);
  assert.deepEqual(data(removed), { ok: true });
  assert.deepEqual(data(await boxRoute(userCookie, 'query', 'find', { envelopeId: draft.id }, headers)).boxes, []);

  // Enviado: 400 para pôr e para tirar.
  assert.equal((await distribute(draft.id)).length, 1);

  for (const [name, input] of [
    ['set', { envelopeId: draft.id, envelopeItemId: draft.item, rect: BOX }],
    ['delete', { envelopeId: draft.id, envelopeItemId: draft.item }],
  ]) {
    const res = await boxRoute(userCookie, 'mutation', name, input, headers);

    assert.equal(res.status, 400, `${name}: ${res.text}`);
  }

  assert.equal(boxRow(draft.item), '');
});

sessionTest('página que não existe mais: a selagem não falha', async () => {
  const nf = await newInvoice('pagina-sumiu', { box: BOX });

  // A nota tem 1 página; a 2ª do arquivo selado é o certificado, que também não pode receber o texto.
  db(`update "RevalleInvoiceAnnotationBox" set page = 2 where "envelopeItemId" = '${nf.item}'`);

  const logsBefore = appLogs().length;

  await finish(nf);

  const sealed = await inspect(nf.item);

  assert.ok(sealed.flat.includes('Certificado de Assinatura'), 'a nota não foi selada com o certificado');
  assert.equal(sealed.conta.length + sealed.cc.length, 0, 'o texto saiu numa página que não existe');

  const logs = appLogs().slice(logsBefore);

  assert.ok(logs.includes('AnnotationPageMissing'), 'a página que falta não foi registrada');
  assert.ok(logs.includes(nf.id), 'o registro não diz qual envio');
  assert.ok(!logs.includes('Fornecedores') && !logs.includes('Armazém'), 'o log tem dados da nota');
});

sessionTest('trocar o arquivo do rascunho apaga o bloco', async () => {
  const draft = await newDraftInvoice('troca-arquivo');

  assert.equal(
    (await setAnnotationBox({ cookie: userCookie, envelopeId: draft.id, envelopeItemId: draft.item })).status,
    200,
  );
  assert.equal(boxRow(draft.item), rectRow(BOX));

  const dataBefore = db(`select "documentDataId" from "EnvelopeItem" where id = '${draft.item}'`);
  const replaced = await replacePdf({
    envelopeId: draft.id,
    envelopeItemId: draft.item,
    file: await danfe('troca-arquivo-novo'),
  });

  assert.equal(replaced.status, 200, replaced.text);
  assert.notEqual(db(`select "documentDataId" from "EnvelopeItem" where id = '${draft.item}'`), dataBefore);
  assert.equal(boxRow(draft.item), '', 'o bloco do arquivo antigo ficou');

  const state = await trpcAs(userCookie, 'query', 'revalle.invoice.get', { envelopeId: draft.id });

  assert.equal(state.status, 200, state.text);
  assert.deepEqual(data(state).annotationBoxes, []);
});

sessionTest('migração: só o que saiu do rascunho ou é nova versão fica com o texto automático', async () => {
  const block = execFileSync('sed', ['-n', '/^-- backfill:inicio$/,/^-- backfill:fim$/p', MIGRATION], {
    encoding: 'utf8',
  });

  assert.ok(block.includes('"autoAnnotation" = true'), 'bloco da marca não achado na migração');

  const draft = await newDraftInvoice('migracao-rascunho');
  const versionDraft = await newDraftInvoice('migracao-versao');
  const sent = await newInvoice('migracao-enviado');
  const ids = [draft.id, versionDraft.id, sent.id].map((id) => `'${id}'`).join(', ');

  // Numa transação desfeita: as três começam sem a marca, a do meio vira "nova versão", e o bloco da migração roda.
  const output = psql(
    [
      'BEGIN;',
      `UPDATE "RevalleInvoiceClassification" SET "autoAnnotation" = false WHERE "envelopeId" IN (${ids});`,
      `UPDATE "RevalleInvoiceClassification" SET "previousEnvelopeId" = '${sent.id}' WHERE "envelopeId" = '${versionDraft.id}';`,
      block,
      `SELECT 'R|' || "envelopeId" || '|' || "autoAnnotation" FROM "RevalleInvoiceClassification" WHERE "envelopeId" IN (${ids});`,
      'ROLLBACK;',
    ].join('\n'),
  );
  const result = Object.fromEntries(
    output
      .split('\n')
      .filter((line) => line.startsWith('R|'))
      .map((line) => line.split('|').slice(1)),
  );

  assert.deepEqual(result, { [draft.id]: 'f', [versionDraft.id]: 't', [sent.id]: 't' });
  // Nada ficou gravado.
  assert.equal(autoAnnotation(versionDraft.id), 'f');
  assert.equal(
    db(
      `select coalesce("previousEnvelopeId", '-') from "RevalleInvoiceClassification" where "envelopeId" = '${versionDraft.id}'`,
    ),
    '-',
  );
});
