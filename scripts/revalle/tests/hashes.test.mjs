// SHA-256 do PDF original (no envio) e do selado (Task 2, Fase 4). Roda contra a stack local.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  fetchIdempotent,
  signIn,
  trpc,
  trpcAs,
} from './helpers.mjs';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const download = async (itemId, version) => {
  const res = await fetch(`${BASE_URL}/api/v2-beta/envelope/item/${itemId}/download?version=${version}`, {
    headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` },
  });

  assert.equal(res.status, 200);

  return Buffer.from(await res.arrayBuffer());
};

let itemId;
let envelopeId;
let afterSend;
let afterSeal;
let originalDownload;
let signedDownload;

beforeEach(() => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
});

before(async () => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);

  const email = `hash-${Date.now()}@revalle.com.br`;
  const created = await createEnvelope({ recipients: [{ email }] });

  assert.equal(created.status, 200, created.text);

  itemId = created.envelope.envelopeItems[0].id;
  envelopeId = created.id;

  const [recipient] = await distribute(created.id);

  afterSend = db(
    `select "originalSha256", coalesce("finalSha256", '') from "RevalleDocumentHash" where "envelopeItemId" = '${itemId}'`,
  ).trim();
  originalDownload = await download(itemId, 'original');

  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const field = created.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');
  const { token } = recipient;

  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
  assert.equal(
    (await trpc('envelope.field.sign', { token, fieldId: field.id, fieldValue: { type: 'SIGNATURE', value: 'Teste' } }))
      .status,
    200,
  );
  assert.equal((await completeWithCode({ token, documentId, email })).status, 200);

  for (let i = 0; i < 60; i += 1) {
    if ((await api('GET', `/envelope/${created.id}`)).body.status === 'COMPLETED') {
      break;
    }

    await sleep(3000);
  }

  signedDownload = await download(itemId, 'signed');
  afterSeal = db(
    `select "originalSha256", "finalSha256" from "RevalleDocumentHash" where "envelopeItemId" = '${itemId}'`,
  ).trim();
});

test('depois do envio existe o hash original e ainda não o final', () => {
  const [original, final] = afterSend.split('|');

  assert.match(original, /^[0-9a-f]{64}$/);
  assert.equal(final, '');
});

test('o hash original é o SHA-256 do download version=original', () => {
  assert.equal(afterSeal.split('|')[0], sha256(originalDownload));
});

test('o hash final é o SHA-256 do download version=signed', () => {
  assert.equal(afterSeal.split('|')[1], sha256(signedDownload));
});

test('original e final são diferentes e o original não muda na selagem', () => {
  const [original, final] = afterSeal.split('|');

  assert.notEqual(original, final);
  assert.equal(original, afterSend.split('|')[0]);
});

// Histórico das versões seladas (uma linha por selagem), da mais antiga para a mais nova.
const sealedHistory = () =>
  db(
    `select h.sha256 || '|' || to_char(h."sealedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') from "RevalleSealedHash" h join "RevalleDocumentHash" d on d.id = h."documentHashId" where d."envelopeItemId" = '${itemId}' order by h."sealedAt"`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, sealedAt] = line.split('|');

      return { sha, sealedAt };
    });

test('a selagem grava a 1ª versão no histórico', () => {
  const history = sealedHistory();

  assert.equal(history.length, 1);
  assert.equal(history[0].sha, sha256(signedDownload));
});

test(
  'reselagem acrescenta uma versão; o /verificar aceita a cópia antiga e a nova',
  admin.email && admin.password ? {} : { skip: 'REVSIGN_ADMIN_EMAIL/PASSWORD não informados' },
  async () => {
    const first = sha256(signedDownload);
    const sealedDataId = db(`select "documentDataId" from "EnvelopeItem" where id = '${itemId}'`);
    const cookie = await signIn(admin.email, admin.password);
    const resealed = await trpcAs(cookie, 'mutation', 'admin.document.reseal', { id: envelopeId });

    assert.ok(resealed.ok, resealed.text);

    for (
      let i = 0;
      i < 60 && db(`select "documentDataId" from "EnvelopeItem" where id = '${itemId}'`) === sealedDataId;
      i += 1
    ) {
      await sleep(1000);
    }

    assert.notEqual(db(`select "documentDataId" from "EnvelopeItem" where id = '${itemId}'`), sealedDataId);

    const second = sha256(await downloadItem(itemId, 'signed'));
    const history = sealedHistory();

    assert.notEqual(second, first, 'a reselagem gerou o mesmo arquivo');
    assert.deepEqual(
      history.map((h) => h.sha),
      [first, second],
      'histórico deve ter a versão antiga e a nova, nessa ordem',
    );

    // A linha principal aponta para a versão atual; o original não muda.
    const [original, final] = db(
      `select "originalSha256", "finalSha256" from "RevalleDocumentHash" where "envelopeItemId" = '${itemId}'`,
    ).split('|');

    assert.equal(final, second);
    assert.equal(original, afterSend.split('|')[0]);

    // /verificar: a versão atual como "documento final" e a anterior listada com a data da selagem. A conferência
    // de arquivo (no navegador) usa exatamente estas versões (findSealedVersionMatch, coberta no Vitest).
    db('delete from "RateLimit"');

    const code = db(
      `select p."verificationCode" from "RevalleSignatureProof" p join "Recipient" r on r.id = p."recipientId" where r."envelopeId" = '${envelopeId}'`,
    );
    const html = await fetchIdempotent(`${BASE_URL}/verificar?codigo=${encodeURIComponent(code)}`, {}, (res) =>
      res.text(),
    );
    const visible = html.replace(/<!-- -->/g, '');

    assert.ok(visible.includes(second), 'hash atual ausente no /verificar');
    assert.ok(visible.includes('Versões seladas anteriores'), 'lista de versões anteriores ausente');
    assert.ok(
      visible.includes(`Selada em ${brasilia(`${history[0].sealedAt}Z`)}: <code>${first}</code>`),
      'versão anterior (com data) ausente no /verificar',
    );
  },
);
