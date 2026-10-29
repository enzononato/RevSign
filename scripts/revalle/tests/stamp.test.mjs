// Carimbo de texto no PDF final, com desenho opcional (Task 6, Fase 4). Roda contra a stack local.
// Extrai texto, fontes e imagens do PDF final com poppler num container alpine (como certificate.test.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, beforeEach, test } from 'node:test';

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
  poppler,
  retryOnStaleSocket,
  signIn,
  trpc,
  trpcAs,
} from './helpers.mjs';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unique = (label) => `stamp-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@revalle.com.br`;
const flat = (text) => text.replace(/\s+/g, ' ');
const count = (text, needle) => text.split(needle).length - 1;

const gate = async (token) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

const waitStatus = async (envelopeId, status) => {
  for (let i = 0; i < 60 && db(`select status from "Envelope" where id = '${envelopeId}'`) !== status; i += 1) {
    await sleep(2000);
  }

  return db(`select status from "Envelope" where id = '${envelopeId}'`);
};

const readProof = (recipientId) => {
  const proof = JSON.parse(
    db(`select row_to_json(p) from "RevalleSignatureProof" p where p."recipientId" = ${recipientId}`) || 'null',
  );

  if (proof && !/[zZ]|[+-]\d\d:?\d\d$/.test(proof.signedAt)) {
    proof.signedAt = `${proof.signedAt}Z`;
  }

  return proof;
};

const stampAudit = (envelopeId) =>
  db(
    `select data->>'signatureKind' from "DocumentAuditLog" where "envelopeId" = '${envelopeId}' and type = 'REVALLE_SIGNATURE_STAMPED'`,
  );

const imageRows = (list) => list.split('\n').filter((line) => /^\s*\d+\s+\d+\s+(image|smask)/.test(line)).length;

// Criação (POST) repete uma vez em socket velho, como antes; downloads (GET) repetem dentro de downloadItem.
const create = (options) => retryOnStaleSocket(() => createEnvelope(options));

// Baixa original e final do primeiro item (a extração com poppler fica para depois dos fluxos).
// `version`: 'signed' (selado) ou 'pending' (em andamento, com o que já foi inserido); grava sempre em signed.pdf.
const fetchPdfs = async (envelope, version = 'signed') => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stamp-'));
  const itemId = envelope.envelopeItems[0].id;

  writeFileSync(path.join(dir, 'original.pdf'), await downloadItem(itemId, 'original'));
  writeFileSync(path.join(dir, 'signed.pdf'), await downloadItem(itemId, version));

  return dir;
};

// Página 1 (onde estão os campos): texto, fontes e imagens; e o texto do PDF inteiro. Um container só.
const extract = (dir) => {
  const [page1, all, fonts, images, originalImages] = poppler(
    dir,
    [
      'pdftotext -f 1 -l 1 /pdf/signed.pdf -',
      'pdftotext /pdf/signed.pdf -',
      'pdffonts -f 1 -l 1 /pdf/signed.pdf',
      'pdfimages -f 1 -l 1 -list /pdf/signed.pdf',
      'pdfimages -f 1 -l 1 -list /pdf/original.pdf',
    ].join(' && echo @@@@ && '),
  ).split('@@@@');

  return {
    dir,
    page1: flat(page1),
    all: flat(all),
    fonts,
    images: imageRows(images),
    originalImages: imageRows(originalImages),
  };
};

const verifySigned = (dir) =>
  execFileSync(
    'sh',
    [
      path.resolve('scripts/revalle/verify-signed-pdf.sh'),
      path.join(dir, 'signed.pdf'),
      path.join(dir, 'original.pdf'),
    ],
    { encoding: 'utf8' },
  );

const createV1 = async ({ email, role = 'SIGNER' }) => {
  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title: `[TESTE] carimbo v1 ${Date.now()}`,
      meta: { distributionMethod: 'NONE' },
      recipients: [
        {
          email,
          name: 'Teste',
          role,
          fields: [{ type: 'SIGNATURE', pageNumber: 1, pageX: 10, pageY: 80, width: 30, height: 8 }],
        },
      ],
    }),
  );
  form.append('file', new File([readFileSync('assets/example.pdf')], 'example.pdf', { type: 'application/pdf' }));

  const res = await retryOnStaleSocket(() =>
    fetch(`${BASE_URL}/api/v2-beta/document/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` },
      body: form,
    }),
  );
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));

  const [recipient] = await distribute(body.envelopeId);
  const envelope = (await api('GET', `/envelope/${body.envelopeId}`)).body;
  const field = envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');

  return { envelopeId: body.envelopeId, documentId: body.id, envelope, recipient, field };
};

// Reselagem pela rota admin; espera o item trocar de documentData.
const adminReseal = async (envelope) => {
  const itemId = envelope.envelopeItems[0].id;
  const sealedDataId = db(`select "documentDataId" from "EnvelopeItem" where id = '${itemId}'`);
  const cookie = await signIn(admin.email, admin.password);
  const resealed = await trpcAs(cookie, 'mutation', 'admin.document.reseal', { id: envelope.id });

  assert.ok(resealed.ok, resealed.text);

  for (
    let i = 0;
    i < 60 && db(`select "documentDataId" from "EnvelopeItem" where id = '${itemId}'`) === sealedDataId;
    i += 1
  ) {
    await sleep(1000);
  }

  assert.notEqual(
    db(`select "documentDataId" from "EnvelopeItem" where id = '${itemId}'`),
    sealedDataId,
    'reselagem não terminou',
  );
};

const baseSql = (sql) =>
  execFileSync(
    'docker',
    ['exec', 'revsign-hml-colaboradores-db-1', 'psql', '-U', 'postgres', '-d', 'colaboradores', '-At', '-c', sql],
    { encoding: 'utf8' },
  ).trim();

const fx = {};

beforeEach(() => {
  db('delete from "RateLimit"');
});

before(async () => {
  // (a) dois campos SIGNATURE, conclui sem assinar nenhum.
  {
    const email = unique('none');
    const created = await create({
      recipients: [
        {
          email,
          fields: [
            { type: 'SIGNATURE', page: 1, positionX: 10, positionY: 80, width: 30, height: 8 },
            { type: 'SIGNATURE', page: 1, positionX: 10, positionY: 90, width: 30, height: 8 },
          ],
        },
      ],
    });

    assert.equal(created.status, 200, created.text);

    const [recipient] = await distribute(created.id);
    const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);

    await gate(recipient.token);
    fx.none = {
      envelope: created.envelope,
      completion: await completeWithCode({ token: recipient.token, documentId, email }),
      status: await waitStatus(created.id, 'COMPLETED'),
      proof: readProof(recipient.id),
      audit: stampAudit(created.id),
      fields: db(
        `select f.inserted::text || ':' || coalesce(s."signatureImageAsBase64", '') || coalesce(s."typedSignature", '') from "Field" f left join "Signature" s on s."fieldId" = f.id where f."recipientId" = ${recipient.id} and f.type = 'SIGNATURE'`,
      ).split('\n'),
    };
    fx.none.dir = await fetchPdfs(created.envelope);
  }

  // (b) assina com desenho (imagem) e conclui; (b2) assina com nome digitado e conclui.
  for (const [key, value] of [
    ['drawn', drawingPng()],
    ['typed', 'Teste Digitado'],
  ]) {
    const email = unique(key);
    const created = await create({ recipients: [{ email }] });

    assert.equal(created.status, 200, created.text);

    const [recipient] = await distribute(created.id);
    const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
    const field = created.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');

    await gate(recipient.token);

    const signed = await trpc('envelope.field.sign', {
      token: recipient.token,
      fieldId: field.id,
      fieldValue: { type: 'SIGNATURE', value },
    });

    assert.equal(signed.status, 200, signed.text);
    fx[key] = {
      completion: await completeWithCode({ token: recipient.token, documentId, email }),
      status: await waitStatus(created.id, 'COMPLETED'),
      proof: readProof(recipient.id),
      audit: stampAudit(created.id),
    };
    fx[key].dir = await fetchPdfs(created.envelope);
  }

  // (d) documento V1 (rota antiga /document/create, inserção com pdf-lib), concluído sem assinar.
  {
    const email = unique('v1');
    const { envelopeId, documentId, envelope, recipient } = await createV1({ email });

    await gate(recipient.token);
    fx.v1 = {
      internalVersion: db(`select "internalVersion" from "Envelope" where id = '${envelopeId}'`),
      completion: await completeWithCode({ token: recipient.token, documentId, email }),
      status: await waitStatus(envelopeId, 'COMPLETED'),
      proof: readProof(recipient.id),
    };
    fx.v1.dir = await fetchPdfs(envelope);
  }

  for (const flow of [fx.none, fx.drawn, fx.typed, fx.v1]) {
    flow.pdf = extract(flow.dir);
  }
});

test('(a) sem assinar o campo: conclui, todo campo SIGNATURE ganha o carimbo com os dados da prova', () => {
  const { completion, status, proof, pdf } = fx.none;

  assert.equal(completion.status, 200, completion.text);
  assert.equal(status, 'COMPLETED');
  assert.ok(proof, 'prova ausente');

  const lines = [
    'Assinado eletronicamente por MARIA TESTE DA SILVA',
    `CPF ${proof.employee.cpfMasked}`,
    `em ${brasilia(new Date(proof.signedAt))} (horário de Brasília)`,
    `Código de verificação: ${proof.verificationCode}`,
  ];

  for (const line of lines) {
    assert.equal(count(pdf.page1, line), 2, `"${line}" deveria aparecer nos 2 campos:\n${pdf.page1}`);
  }

  assert.match(proof.employee.cpfMasked, /^\*\*\*\.\d{3}\.\d{3}-\*\*$/);
  assert.equal(count(pdf.page1, '/verificar'), 2);
  assert.match(pdf.page1, /Confira em https?:\/\/\S+\/verificar/);
  assert.ok(!pdf.all.includes(MARIA.cpf), 'CPF completo no PDF');
});

test('(a) o carimbo é texto real em Noto Sans (fonte com acentos), não Caveat nem imagem', () => {
  assert.match(fx.none.pdf.fonts, /NotoSans/);
  assert.doesNotMatch(fx.none.pdf.fonts, /Caveat/i);
  assert.equal(fx.none.pdf.images, fx.none.pdf.originalImages);
});

test('(a) a prova e o log registram que não desenhou; os campos ficam inseridos sem imagem nem texto', () => {
  assert.equal(fx.none.proof.drewSignature, false);
  assert.equal(fx.none.proof.signatureKind, 'NONE');
  assert.equal(fx.none.audit, 'NONE');
  assert.deepEqual(fx.none.fields, ['true:', 'true:']);
  assert.ok(
    fx.none.pdf.all.includes('Assinatura registrada pelo carimbo, sem desenho'),
    'evento ausente no log do PDF',
  );
});

test('(b) com desenho: o carimbo continua, o desenho entra como imagem e drewSignature=true', () => {
  const { completion, status, proof, pdf, audit } = fx.drawn;

  assert.equal(completion.status, 200, completion.text);
  assert.equal(status, 'COMPLETED');
  assert.equal(proof.drewSignature, true);
  assert.equal(proof.signatureKind, 'IMAGE');
  assert.equal(audit, 'IMAGE');
  assert.ok(pdf.page1.includes('Assinado eletronicamente por MARIA TESTE DA SILVA'), pdf.page1);
  assert.ok(pdf.page1.includes(`CPF ${proof.employee.cpfMasked}`), pdf.page1);
  assert.ok(pdf.page1.includes(`Código de verificação: ${proof.verificationCode}`));
  assert.ok(pdf.images > pdf.originalImages, 'desenho ausente na página 1');
});

test('(b2) com nome digitado: kind TYPED, o carimbo continua e o texto digitado é desenhado', () => {
  const { completion, status, proof, pdf, audit } = fx.typed;

  assert.equal(completion.status, 200, completion.text);
  assert.equal(status, 'COMPLETED');
  assert.equal(proof.signatureKind, 'TYPED');
  assert.equal(proof.drewSignature, false);
  assert.equal(audit, 'TYPED');
  assert.ok(pdf.page1.includes('Assinado eletronicamente por MARIA TESTE DA SILVA'), pdf.page1);
  assert.ok(pdf.page1.includes(`CPF ${proof.employee.cpfMasked}`), pdf.page1);
  assert.ok(pdf.page1.includes('Teste Digitado'), pdf.page1);
  assert.match(pdf.fonts, /Caveat/i);
});

test('(c) verify-signed-pdf.sh passa nos dois PDFs', () => {
  for (const { pdf } of [fx.none, fx.drawn]) {
    const out = verifySigned(pdf.dir);

    assert.match(out, /OK {4}assinatura íntegra/);
    assert.match(out, /OK {4}assinatura cobre o documento inteiro/);
  }
});

test('(d) documento V1 (pdf-lib): concluído sem assinar, o carimbo sai como texto', () => {
  const { internalVersion, completion, status, proof, pdf } = fx.v1;

  assert.equal(internalVersion, '1');
  assert.equal(completion.status, 200, completion.text);
  assert.equal(status, 'COMPLETED');
  assert.equal(proof.signatureKind, 'NONE');

  for (const line of [
    'Assinado eletronicamente por MARIA TESTE DA SILVA',
    `CPF ${proof.employee.cpfMasked}`,
    `em ${brasilia(new Date(proof.signedAt))} (horário de Brasília)`,
    `Código de verificação: ${proof.verificationCode}`,
  ]) {
    assert.ok(pdf.page1.includes(line), `"${line}" ausente:\n${pdf.page1}`);
  }

  assert.match(pdf.fonts, /NotoSans/);
  verifySigned(pdf.dir);
});

test('adversarial: assinatura vazia, só com espaços ou imagem falsa pela rota V2 do cliente é recusada', async () => {
  const email = unique('empty');
  const created = await create({ recipients: [{ email }] });

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);
  const field = created.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');

  await gate(recipient.token);

  for (const value of ['', '   ', 'data:image/png;base64,', 'data:image/jpeg;base64,/9j/4AAQ']) {
    const res = await trpc('envelope.field.sign', {
      token: recipient.token,
      fieldId: field.id,
      fieldValue: { type: 'SIGNATURE', value },
    });

    assert.notEqual(res.status, 200, `valor ${JSON.stringify(value)} aceito`);
  }

  assert.equal(db(`select inserted::text from "Field" where id = ${field.id}`), 'false');
  assert.equal(db(`select count(*) from "Signature" where "fieldId" = ${field.id}`), '0');
});

test('sem prova (documento anterior à Fase 4): a reselagem não inventa carimbo', async (t) => {
  if (!admin.email || !admin.password) {
    t.skip('sem credenciais de admin');

    return;
  }

  const email = unique('legacy');
  const created = await create({ recipients: [{ email }] });

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);
  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const field = created.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');

  await gate(recipient.token);
  await trpc('envelope.field.sign', {
    token: recipient.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Teste' },
  });
  assert.equal((await completeWithCode({ token: recipient.token, documentId, email })).status, 200);
  assert.equal(await waitStatus(created.id, 'COMPLETED'), 'COMPLETED');

  db(`delete from "RevalleSignatureProof" where "recipientId" = ${recipient.id}`);
  await adminReseal(created.envelope);

  const pdf = extract(await fetchPdfs(created.envelope));

  assert.ok(!pdf.page1.includes('Assinado eletronicamente'), pdf.page1);
  assert.ok(pdf.page1.includes('Teste'), pdf.page1);
});

test('adversarial V1: isBase64 com valor que não é PNG é recusado; um PNG de verdade passa', async () => {
  const { recipient, field } = await createV1({ email: unique('v1-fake') });

  await gate(recipient.token);

  for (const value of ['x', 'data:image/png;base64,', 'data:image/png;base64,AAAA']) {
    const res = await trpc('field.signFieldWithToken', {
      token: recipient.token,
      fieldId: field.id,
      value,
      isBase64: true,
    });

    assert.notEqual(res.status, 200, `valor ${JSON.stringify(value)} aceito`);
  }

  assert.equal(db(`select inserted::text from "Field" where id = ${field.id}`), 'false');

  const valid = await trpc('field.signFieldWithToken', {
    token: recipient.token,
    fieldId: field.id,
    value: drawingPng(),
    isBase64: true,
  });

  assert.equal(valid.status, 200, valid.text);
});

test('APPROVER com campo SIGNATURE vazio não conclui; preenchido, conclui sem carimbo', async () => {
  const email = unique('approver');
  const created = await create({ recipients: [{ email, role: 'APPROVER' }] });

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);
  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const field = created.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');

  await gate(recipient.token);

  const blocked = await completeWithCode({ token: recipient.token, documentId, email });

  assert.notEqual(blocked.status, 200, 'APPROVER concluiu sem preencher a assinatura');
  assert.match(blocked.text, /RECIPIENT_HAS_UNSIGNED_FIELDS/);
  assert.equal(db(`select inserted::text from "Field" where id = ${field.id}`), 'false');

  const signed = await trpc('envelope.field.sign', {
    token: recipient.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Aprovado' },
  });

  assert.equal(signed.status, 200, signed.text);
  assert.equal((await completeWithCode({ token: recipient.token, documentId, email })).status, 200);
  assert.equal(await waitStatus(created.id, 'COMPLETED'), 'COMPLETED');
  assert.equal(stampAudit(created.id), '');

  const pdf = extract(await fetchPdfs(created.envelope));

  assert.ok(!pdf.page1.includes('Assinado eletronicamente'), pdf.page1);
  assert.ok(pdf.page1.includes('Aprovado'), pdf.page1);
});

test('PDF em andamento: quem já concluiu aparece com o carimbo', async () => {
  const first = unique('pending-a');
  const second = unique('pending-b');
  const created = await create({
    recipients: [
      { email: first },
      {
        email: second,
        fields: [{ type: 'SIGNATURE', page: 1, positionX: 55, positionY: 90, width: 30, height: 8 }],
      },
    ],
  });

  assert.equal(created.status, 200, created.text);

  const recipients = await distribute(created.id);
  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const a = recipients.find((r) => r.email === first);

  await gate(a.token);
  assert.equal((await completeWithCode({ token: a.token, documentId, email: first })).status, 200);

  const proof = readProof(a.id);
  const pdf = extract(await fetchPdfs(created.envelope, 'pending'));

  assert.equal(db(`select status from "Envelope" where id = '${created.id}'`), 'PENDING');
  assert.ok(pdf.page1.includes('Assinado eletronicamente por MARIA TESTE DA SILVA'), pdf.page1);
  assert.ok(pdf.page1.includes(`Código de verificação: ${proof.verificationCode}`), pdf.page1);
  assert.equal(count(pdf.page1, 'Assinado eletronicamente'), 1);
});

test('reselar depois de mudar o nome no RH não altera o carimbo (nome congelado na prova)', async (t) => {
  if (!admin.email || !admin.password) {
    t.skip('sem credenciais de admin');

    return;
  }

  const originalName = baseSql(`select nome_completo from rh_colaboradores where cpf_completo = '${MARIA.cpf}'`);

  try {
    baseSql(`update rh_colaboradores set nome_completo = 'Nome Trocado Depois' where cpf_completo = '${MARIA.cpf}'`);
    await adminReseal(fx.none.envelope);
  } finally {
    baseSql(
      `update rh_colaboradores set nome_completo = '${originalName.replaceAll("'", "''")}' where cpf_completo = '${MARIA.cpf}'`,
    );
  }

  const pdf = extract(await fetchPdfs(fx.none.envelope));

  assert.equal(count(pdf.page1, 'Assinado eletronicamente por MARIA TESTE DA SILVA'), 2, pdf.page1);
  assert.ok(!pdf.page1.toUpperCase().includes('NOME TROCADO'), pdf.page1);
  assert.equal(count(pdf.page1, `Código de verificação: ${fx.none.proof.verificationCode}`), 2);
});
