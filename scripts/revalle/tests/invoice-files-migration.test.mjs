// Fase 9, Task 1: a migração `20261116100000_revalle_invoice_files` (uma linha por arquivo do envio, `RevalleInvoiceFile`)
// e o backfill dela. O backfill cria a linha NF de cada NF de envelope com um arquivo só, copiando da classificação, e é
// idempotente; o helper `runInvoiceFilesBackfill` roda de novo o mesmo bloco da migração.
//
//   - logo depois da subida (o app aplica a migração), toda NF de um arquivo tem a linha da nota, igual ao espelho;
//   - envio antigo de uma nota (simulado: as linhas de arquivo apagadas depois do envio): a linha volta no item, com o
//     hash do envio (`RevalleDocumentHash`), a conta e o centro; rodar de novo não duplica;
//   - rascunho antigo de um arquivo (sem hash do envio): usa o hash da classificação.
//
// Desde a Task 2 o app grava "da nota" na linha do arquivo e o espelho em seguida: o primeiro caso vale sempre, e confere
// todas as colunas espelhadas. Sem IA: só a detecção pelo texto. Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN) e REVSIGN_ADMIN_*
// (garante a conta 2.1.03 ativa). Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import {
  api,
  assertNoPaidGeminiCalls,
  chooseInvoice,
  createEnvelope,
  danfePdfFile,
  db,
  ensureInvoiceAccounts,
  runInvoiceFilesBackfill,
  signIn,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const company = (tag) => `nf-arquivos-${tag}-${RUN}@revalle.com.br`;

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

let userCookie;

const sessionTest = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie) {
      t.skip('credenciais de sessão não informadas (REVSIGN_USER_*, REVSIGN_ADMIN_*)');

      return;
    }

    await fn(t);
  });

before(async () => {
  if (!user.email || !user.password || !admin.email || !admin.password) {
    return;
  }

  userCookie = await signIn(user.email, user.password);
  await ensureInvoiceAccounts(await signIn(admin.email, admin.password));
});

const fileRows = (envelopeId) => db(`select count(*) from "RevalleInvoiceFile" where "envelopeId" = '${envelopeId}'`);
const fileRow = (envelopeId, columns) =>
  db(`select ${columns} from "RevalleInvoiceFile" where "envelopeId" = '${envelopeId}'`);
const onlyItemId = (envelopeId) => {
  const ids = db(`select id from "EnvelopeItem" where "envelopeId" = '${envelopeId}'`).split('\n').filter(Boolean);

  assert.equal(ids.length, 1, `o envelope de teste tem um arquivo só: ${ids.length}`);

  return ids[0];
};

const newDanfeEnvelope = async (tag) => {
  const created = await createEnvelope({
    recipients: [{ email: company(tag) }],
    pdf: danfePdfFile(`f9-migracao-${tag}-${RUN}`),
    title: `[TESTE NF] migração por arquivo ${tag} ${RUN}`,
  });

  assert.equal(created.status, 200, created.text);

  return created.id;
};

test('toda NF de um arquivo tem a linha da nota, igual ao espelho', () => {
  // NF de envelope com um arquivo sem a linha NF.
  const missing = db(`
    select count(*) from "RevalleInvoiceClassification" c
    where c."isInvoice" = 'YES'
      and (select count(*) from "EnvelopeItem" i where i."envelopeId" = c."envelopeId") = 1
      and not exists (
        select 1 from "RevalleInvoiceFile" f where f."envelopeId" = c."envelopeId" and f.kind = 'NF'
      )`);

  assert.equal(missing, '0');

  // Envelopes com exatamente uma linha NF: a linha e o espelho dizem a mesma coisa.
  const total = db(`
    select count(*) from "RevalleInvoiceClassification" c
    join "RevalleInvoiceFile" f on f."envelopeId" = c."envelopeId" and f.kind = 'NF'
    where (select count(*) from "RevalleInvoiceFile" g where g."envelopeId" = c."envelopeId" and g.kind = 'NF') = 1`);
  const different = db(`
    select count(*) from "RevalleInvoiceClassification" c
    join "RevalleInvoiceFile" f on f."envelopeId" = c."envelopeId" and f.kind = 'NF'
    where (select count(*) from "RevalleInvoiceFile" g where g."envelopeId" = c."envelopeId" and g.kind = 'NF') = 1
      and (
        c."choiceCode" is distinct from f."choiceCode"
        or c."costCenterCode" is distinct from f."costCenterCode"
        or c."costCenterValidatedAt" is distinct from f."costCenterValidatedAt"
        or c."approvedAt" is distinct from f."approvedAt"
        or c."accessKeys" is distinct from f."accessKeys"
        or c."suggestionStatus" is distinct from f."suggestionStatus"
        or c.suggestion is distinct from f.suggestion
        or c."suggestionAttempts" is distinct from f."suggestionAttempts"
        or c."supplierName" is distinct from f."supplierName"
        or c."invoiceNumber" is distinct from f."invoiceNumber"
        or c."totalAmountCents" is distinct from f."totalAmountCents"
        or c."choiceById" is distinct from f."choiceById"
        or c."choiceAt" is distinct from f."choiceAt"
        or c."acceptedSuggestion" is distinct from f."acceptedSuggestion"
        or c."costCenterById" is distinct from f."costCenterById"
        or c."costCenterAt" is distinct from f."costCenterAt"
        or c."costCenterValidatedById" is distinct from f."costCenterValidatedById"
        or c."costCenterValidatedByName" is distinct from f."costCenterValidatedByName"
        or c."approvedById" is distinct from f."approvedById"
        or c."approvedAccountName" is distinct from f."approvedAccountName"
        or c."approvedByName" is distinct from f."approvedByName"
      )`);

  assert.ok(Number(total) > 0, 'a stack local tem NFs de um arquivo (rode a suíte de notas antes, se estiver vazia)');
  assert.equal(different, '0');
});

sessionTest('backfill de um envio antigo de uma nota (simulado)', async () => {
  const envelopeId = await newDanfeEnvelope('enviado');

  assert.equal((await chooseInvoice({ cookie: userCookie, envelopeId })).status, 200);

  const sent = await api('POST', '/envelope/distribute', { envelopeId });

  assert.equal(sent.status, 200, sent.text);
  assert.equal(db(`select status from "Envelope" where id = '${envelopeId}'`), 'PENDING');

  const itemId = onlyItemId(envelopeId);
  const sentHash = db(`select "originalSha256" from "RevalleDocumentHash" where "envelopeItemId" = '${itemId}'`);

  assert.match(sentHash, /^[0-9a-f]{64}$/);

  // Envio de antes da Fase 9: sem linha de arquivo.
  db(`delete from "RevalleInvoiceFile" where "envelopeId" = '${envelopeId}'`);
  assert.equal(fileRows(envelopeId), '0');

  runInvoiceFilesBackfill();

  assert.equal(fileRows(envelopeId), '1');
  assert.equal(
    fileRow(
      envelopeId,
      `kind || '|' || "envelopeItemId" || '|' || coalesce("fileSha256", '-') || '|' || coalesce("choiceCode", '-') || '|' || coalesce("costCenterCode", '-') || '|' || "detectedBy"`,
    ),
    `NF|${itemId}|${sentHash}|2.1.03|101|TEXT`,
  );
  // As colunas da nota vieram da classificação (aqui, as de quem escolheu).
  const copied = db(`
    select count(*) from "RevalleInvoiceFile" f
    join "RevalleInvoiceClassification" c on c."envelopeId" = f."envelopeId"
    where f."envelopeId" = '${envelopeId}'
      and c."choiceById" is not null
      and f."choiceById" = c."choiceById"
      and f."choiceAt" = c."choiceAt"
      and f."costCenterById" = c."costCenterById"
      and f."suggestionStatus" = c."suggestionStatus"
      and f."accessKeys" = c."accessKeys"`);

  assert.equal(copied, '1');

  // Idempotente: rodar de novo não cria outra linha.
  runInvoiceFilesBackfill();

  assert.equal(fileRows(envelopeId), '1');
});

sessionTest('rascunho antigo de um arquivo usa o hash do envelope', async () => {
  const envelopeId = await newDanfeEnvelope('rascunho');
  const classified = await trpcAs(userCookie, 'mutation', 'revalle.invoice.classify', { envelopeId });

  assert.equal(classified.status, 200, classified.text);

  const itemId = onlyItemId(envelopeId);
  const envelopeHash = db(
    `select coalesce("fileSha256", '-') from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}' and "isInvoice" = 'YES'`,
  );

  assert.match(envelopeHash, /^[0-9a-f]{64}$/);
  // Rascunho: ainda sem o hash do envio.
  assert.equal(db(`select count(*) from "RevalleDocumentHash" where "envelopeItemId" = '${itemId}'`), '0');

  db(`delete from "RevalleInvoiceFile" where "envelopeId" = '${envelopeId}'`);
  runInvoiceFilesBackfill();

  assert.equal(fileRows(envelopeId), '1');
  assert.equal(
    fileRow(envelopeId, `kind || '|' || "envelopeItemId" || '|' || coalesce("fileSha256", '-')`),
    `NF|${itemId}|${envelopeHash}`,
  );
});
