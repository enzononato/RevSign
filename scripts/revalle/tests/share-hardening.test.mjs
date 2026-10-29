// Links públicos de compartilhamento desligados (Fase 2, Task 4): documento interno não ganha link público nem cartão
// para rede social. `document.share` (tRPC) recusa tudo e não grava nada; `/share/<slug>/opengraph` responde 404.
// Requer REVSIGN_API_TOKEN. O teste do dono logado usa REVSIGN_USER_EMAIL/REVSIGN_USER_PASSWORD (dono do token).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE_URL, createEnvelope, db, distribute, signIn, trpc, trpcAs } from './helpers.mjs';

const USER_EMAIL = process.env.REVSIGN_USER_EMAIL;
const USER_PASSWORD = process.env.REVSIGN_USER_PASSWORD;
const unique = () => `share-${Date.now()}-${Math.floor(Math.random() * 1e6)}@revalle.com.br`;

const newDocument = async () => {
  const created = await createEnvelope({ recipients: [{ email: unique() }] });

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);
  const documentId = Number(String(created.envelope.secondaryId).split('_').pop());

  return { envelopeId: created.id, documentId, recipient };
};

const shareRows = (envelopeId) => db(`select count(*) from "DocumentShareLink" where "envelopeId" = '${envelopeId}'`);

test('document.share com o token do destinatário é recusado e não grava link', async () => {
  const { envelopeId, documentId, recipient } = await newDocument();

  const res = await trpc('document.share', { documentId, token: recipient.token });

  assert.notEqual(res.status, 200, res.text);
  assert.equal(res.body?.result?.data?.json?.slug, undefined, res.text);
  assert.equal(shareRows(envelopeId), '0');
});

test('document.share pelo dono logado é recusado e não grava link', {
  skip: !(USER_EMAIL && USER_PASSWORD) && 'sem REVSIGN_USER_EMAIL/REVSIGN_USER_PASSWORD',
}, async () => {
  const { envelopeId, documentId } = await newDocument();
  const cookie = await signIn(USER_EMAIL, USER_PASSWORD);

  const res = await trpcAs(cookie, 'mutation', 'document.share', { documentId });

  assert.notEqual(res.status, 200, res.text);
  assert.equal(res.body?.result?.data?.json?.slug, undefined, res.text);
  assert.equal(shareRows(envelopeId), '0');
});

test('/share/<slug>/opengraph responde 404 para um link existente (cartão público desligado)', async () => {
  const { envelopeId, recipient } = await newDocument();
  // Linha criada só para o teste (um link que já existisse antes do bloqueio); não é token de acesso.
  const slug = `revtest${Date.now()}`;

  db(
    `insert into "DocumentShareLink" (email, slug, "envelopeId", "createdAt", "updatedAt") values ('${recipient.email}', '${slug}', '${envelopeId}', now(), now())`,
  );

  try {
    const res = await fetch(`${BASE_URL}/share/${slug}/opengraph`);

    assert.equal(res.status, 404);
    assert.ok(!(res.headers.get('content-type') ?? '').startsWith('image/'), 'não pode devolver imagem');
  } finally {
    db(`delete from "DocumentShareLink" where slug = '${slug}'`);
  }
});
