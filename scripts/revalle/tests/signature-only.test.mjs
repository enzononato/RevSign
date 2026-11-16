// Só o campo de assinatura e assinatura de cada signatário em cada documento (decisão de 13/11/2026).
// Roda contra a stack local. Usa REVSIGN_API_TOKEN e a sessão de REVSIGN_USER_* (dono do token, para as rotas da tela).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, test } from 'node:test';

import './account-autologin.mjs'; // conta obrigatória (16/11/2026): entra na conta de quem assina pelo e-mail da empresa
import {
  api,
  BASE_URL,
  completeWithCode,
  createEnvelope,
  db,
  distribute,
  retryCreateOnStaleSocket,
  signIn,
  trpc,
  trpcAs,
} from './helpers.mjs';

const ONLY_SIGNATURE = 'Só o campo de assinatura é permitido.';
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const unique = (label) => `so-assinatura-${label}-${RUN}@revalle.com.br`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const signatureAt = (identifier) => ({
  type: 'SIGNATURE',
  identifier,
  page: 1,
  positionX: 10,
  positionY: 80,
  width: 30,
  height: 8,
});

let userCookie;

before(async () => {
  userCookie = await signIn(process.env.REVSIGN_USER_EMAIL, process.env.REVSIGN_USER_PASSWORD);
});

const teamOf = (envelopeId) => db(`select "teamId" from "Envelope" where id = '${envelopeId}'`);
const statusOf = (envelopeId) => db(`select status from "Envelope" where id = '${envelopeId}'`);

// Envelope com dois documentos (o mesmo PDF com nomes diferentes). `recipients[].fields` com `identifier` 0 ou 1.
const createTwoDocuments = async (recipients) => {
  const form = new FormData();
  const pdf = readFileSync('assets/example.pdf');

  form.append(
    'payload',
    JSON.stringify({
      title: `[TESTE] só assinatura ${RUN}`,
      type: 'DOCUMENT',
      meta: { distributionMethod: 'NONE' },
      recipients,
    }),
  );
  form.append('files', new File([pdf], 'contrato.pdf', { type: 'application/pdf' }));
  form.append('files', new File([pdf], 'aditivo.pdf', { type: 'application/pdf' }));

  const res = await retryCreateOnStaleSocket(async () => {
    const response = await fetch(`${BASE_URL}/api/v2-beta/envelope/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` },
      body: form,
    });

    return { status: response.status, text: await response.text() };
  });

  assert.equal(res.status, 200, res.text);

  const { id } = JSON.parse(res.text);
  const envelope = (await api('GET', `/envelope/${id}`)).body;
  const items = [...envelope.envelopeItems].sort((a, b) => a.order - b.order);

  return { id, envelope, items };
};

const create = (options) => retryCreateOnStaleSocket(() => createEnvelope(options));

test('API v2: criar envelope com campo de nome ou texto é recusado', async () => {
  for (const type of ['NAME', 'TEXT']) {
    const res = await create({
      recipients: [
        {
          email: unique(`criar-${type.toLowerCase()}`),
          fields: [
            { type: 'SIGNATURE', page: 1, positionX: 10, positionY: 80, width: 30, height: 8 },
            { type, page: 1, positionX: 50, positionY: 80, width: 30, height: 5 },
          ],
        },
      ],
    });

    assert.equal(res.status, 400, `${type}: ${res.text}`);
    assert.ok(res.text.includes(ONLY_SIGNATURE), res.text);
  }
});

test('API v2: adicionar campo de texto ou trocar a assinatura por nome é recusado; assinatura passa', async () => {
  const created = await create({ recipients: [{ email: unique('api-campos') }] });

  assert.equal(created.status, 200, created.text);

  const recipientId = created.envelope.recipients[0].id;
  const signature = created.envelope.fields[0];
  const position = { page: 1, positionX: 50, positionY: 50, width: 30, height: 5 };

  const text = await api('POST', '/envelope/field/create-many', {
    envelopeId: created.id,
    data: [{ recipientId, type: 'TEXT', ...position }],
  });

  assert.equal(text.status, 400, text.text);
  assert.ok(text.text.includes(ONLY_SIGNATURE), text.text);

  const changed = await api('POST', '/envelope/field/update-many', {
    envelopeId: created.id,
    data: [{ id: signature.id, type: 'NAME' }],
  });

  assert.equal(changed.status, 400, changed.text);
  assert.ok(changed.text.includes(ONLY_SIGNATURE), changed.text);
  assert.equal(db(`select type from "Field" where id = ${signature.id}`), 'SIGNATURE');

  const ok = await api('POST', '/envelope/field/create-many', {
    envelopeId: created.id,
    data: [{ recipientId, type: 'SIGNATURE', ...position }],
  });

  assert.equal(ok.status, 200, ok.text);
  assert.equal(db(`select count(*) from "Field" where "envelopeId" = '${created.id}' and type <> 'SIGNATURE'`), '0');
});

test('API v1: criar campo de nome é recusado', async () => {
  const created = await create({ recipients: [{ email: unique('v1') }] });

  assert.equal(created.status, 200, created.text);

  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const res = await fetch(`${BASE_URL}/api/v1/documents/${documentId}/fields`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipientId: created.envelope.recipients[0].id,
      type: 'NAME',
      pageNumber: 1,
      pageX: 50,
      pageY: 50,
      pageWidth: 30,
      pageHeight: 5,
    }),
  });
  const body = await res.text();

  assert.equal(res.status, 400, body);
  assert.ok(body.includes(ONLY_SIGNATURE), body);
});

test('tela (tRPC envelope.field.set): campo novo de nome é recusado; campo antigo de outro tipo continua', async () => {
  const created = await create({ recipients: [{ email: unique('tela') }] });

  assert.equal(created.status, 200, created.text);

  const { id: envelopeId, envelope } = created;
  const recipientId = envelope.recipients[0].id;
  const itemId = envelope.envelopeItems[0].id;
  const signature = envelope.fields[0];

  // Campo NAME "de antes desta versão", gravado direto no banco.
  db(
    `insert into "Field" ("secondaryId", "envelopeId", "envelopeItemId", "recipientId", type, page, "positionX", "positionY", width, height, "customText", inserted, "fieldMeta") values ('legado-${RUN}', '${envelopeId}', '${itemId}', ${recipientId}, 'NAME', 1, 55, 60, 30, 5, '', false, '{"type":"name"}')`,
  );

  const legacyId = Number(db(`select id from "Field" where "secondaryId" = 'legado-${RUN}'`));
  const asField = (field) => ({
    id: field.id,
    envelopeItemId: itemId,
    recipientId,
    type: field.type,
    page: 1,
    positionX: Number(field.positionX),
    positionY: Number(field.positionY),
    width: Number(field.width),
    height: Number(field.height),
    fieldMeta: field.fieldMeta ?? {},
  });
  const current = (await api('GET', `/envelope/${envelopeId}`)).body.fields;
  const legacy = current.find((field) => field.id === legacyId);
  const kept = [asField(signature), { ...asField(legacy), positionY: 62 }];
  const headers = { 'x-team-id': teamOf(envelopeId) };

  const withNewName = await trpcAs(
    userCookie,
    'mutation',
    'envelope.field.set',
    {
      envelopeId,
      envelopeType: 'DOCUMENT',
      fields: [...kept, { ...asField(legacy), id: undefined, positionY: 40, fieldMeta: { type: 'name' } }],
    },
    headers,
  );

  assert.equal(withNewName.status, 400, withNewName.text);
  assert.ok(withNewName.text.includes(ONLY_SIGNATURE), withNewName.text);

  const keptOnly = await trpcAs(
    userCookie,
    'mutation',
    'envelope.field.set',
    { envelopeId, envelopeType: 'DOCUMENT', fields: kept },
    headers,
  );

  assert.equal(keptOnly.status, 200, keptOnly.text);
  assert.equal(db(`select type || ':' || "positionY"::int from "Field" where id = ${legacyId}`), 'NAME:62');
});

test('documento antigo com campo de nome é enviado, assinado e selado', async () => {
  const email = unique('legado');
  const created = await create({ recipients: [{ email }] });

  assert.equal(created.status, 200, created.text);

  const { id: envelopeId, envelope } = created;
  const recipientId = envelope.recipients[0].id;

  db(
    `insert into "Field" ("secondaryId", "envelopeId", "envelopeItemId", "recipientId", type, page, "positionX", "positionY", width, height, "customText", inserted, "fieldMeta") values ('legado-envio-${RUN}', '${envelopeId}', '${envelope.envelopeItems[0].id}', ${recipientId}, 'NAME', 1, 55, 60, 30, 5, '', false, '{"type":"name"}')`,
  );

  const [recipient] = await distribute(envelopeId);

  assert.ok(recipient?.token, 'o envio não devolveu o destinatário');

  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token: recipient.token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token: recipient.token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token: recipient.token, isMe: true });

  const fields = (await api('GET', `/envelope/${envelopeId}`)).body.fields;
  const nameField = fields.find((field) => field.type === 'NAME');
  const signatureField = fields.find((field) => field.type === 'SIGNATURE');

  const signedName = await trpc('envelope.field.sign', {
    token: recipient.token,
    fieldId: nameField.id,
    fieldValue: { type: 'NAME', value: 'Maria Teste' },
  });

  assert.equal(signedName.status, 200, signedName.text);

  const signedSignature = await trpc('envelope.field.sign', {
    token: recipient.token,
    fieldId: signatureField.id,
    fieldValue: { type: 'SIGNATURE', value: 'Maria Teste' },
  });

  assert.equal(signedSignature.status, 200, signedSignature.text);

  const documentId = Number.parseInt(envelope.secondaryId.split('_')[1], 10);
  const done = await completeWithCode({ token: recipient.token, documentId, email });

  assert.equal(done.status, 200, done.text);

  for (let i = 0; i < 60 && statusOf(envelopeId) !== 'COMPLETED'; i += 1) {
    await sleep(2000);
  }

  assert.equal(statusOf(envelopeId), 'COMPLETED');
  assert.equal(db(`select inserted from "Field" where id = ${nameField.id}`), 't');

  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
});

test('envio: dois documentos com a assinatura só no primeiro é recusado nomeando o segundo', async () => {
  const { id, items } = await createTwoDocuments([
    { role: 'SIGNER', name: 'Fulano Teste', email: unique('so-no-1'), fields: [signatureAt(0)] },
  ]);
  const message = `Falta a posição da assinatura de Fulano Teste no documento ${items[1].title}.`;

  const viaApi = await api('POST', '/envelope/distribute', { envelopeId: id });

  assert.equal(viaApi.status, 400, viaApi.text);
  assert.ok(viaApi.text.includes(message), viaApi.text);
  assert.ok(!viaApi.text.includes(`no documento ${items[0].title}.`), viaApi.text);

  const viaScreen = await trpcAs(
    userCookie,
    'mutation',
    'envelope.distribute',
    { envelopeId: id },
    { 'x-team-id': teamOf(id) },
  );

  assert.equal(viaScreen.status, 400, viaScreen.text);
  assert.ok(viaScreen.text.includes(message), viaScreen.text);
  assert.ok(viaScreen.text.includes('MISSING_SIGNATURE_FIELD'), viaScreen.text);

  assert.equal(statusOf(id), 'DRAFT');
  assert.equal(
    db(`select count(*) from "DocumentAuditLog" where "envelopeId" = '${id}' and type = 'DOCUMENT_SENT'`),
    '0',
  );
});

test('envio: signatário sem campo nenhum é recusado nos dois documentos, com o e-mail quando não há nome', async () => {
  const email = unique('sem-campo');
  const { id, items } = await createTwoDocuments([
    { role: 'SIGNER', name: 'Com Campos', email: unique('com-campos'), fields: [signatureAt(0), signatureAt(1)] },
    { role: 'SIGNER', name: '', email, fields: [] },
  ]);

  const res = await api('POST', '/envelope/distribute', { envelopeId: id });

  assert.equal(res.status, 400, res.text);

  for (const item of items) {
    assert.ok(res.text.includes(`Falta a posição da assinatura de ${email} no documento ${item.title}.`), res.text);
  }

  assert.ok(!res.text.includes('Com Campos'), res.text);
  assert.equal(statusOf(id), 'DRAFT');
});

test('envio: assinatura nos dois documentos sai', async () => {
  const { id } = await createTwoDocuments([
    { role: 'SIGNER', name: 'Fulano Teste', email: unique('nos-dois'), fields: [signatureAt(0), signatureAt(1)] },
  ]);

  const recipients = await distribute(id);

  assert.equal(recipients?.length, 1, JSON.stringify(recipients));
  assert.equal(statusOf(id), 'PENDING');
});

test('envio: aprovador sem campo nenhum não impede o envio', async () => {
  const { id } = await createTwoDocuments([
    { role: 'SIGNER', name: 'Fulano Teste', email: unique('signatario'), fields: [signatureAt(0), signatureAt(1)] },
    { role: 'APPROVER', name: 'Aprovador Teste', email: unique('aprovador'), fields: [] },
    { role: 'CC', name: 'Cópia Teste', email: unique('copia'), fields: [] },
  ]);

  const recipients = await distribute(id);

  assert.equal(recipients?.length, 3, JSON.stringify(recipients));
  assert.equal(statusOf(id), 'PENDING');
});
