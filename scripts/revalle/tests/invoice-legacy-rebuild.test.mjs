// Fase 9, correções da Task 2: o refazer das linhas de arquivo de envios de antes da Fase 9 (`ensureLegacyInvoiceFiles`) e
// o backfill da subida.
//
//   - envio antigo (enviado) com dois arquivos, sem linhas de arquivo: a leitura refaz as linhas (a nota no DANFE, "outro" no
//     contrato) e as chaves de acesso do arquivo "outro" vêm do texto;
//   - o mesmo pelo caminho do backfill da subida (`bootstrap`): o teste chama o
//     reinício do app só se REVSIGN_RESTART_CMD estiver definido; sem ele, esse caso é pulado;
//   - envio sem arquivo nenhum não é pego de novo pelo backfill (a consulta exige ao menos um item);
//   - "Enviar de novo" de um rascunho de antes da Fase 9 (`allowDraft`): com os mesmos arquivos as linhas são refeitas
//     e a aprovação fica; com o arquivo trocado pelo dono, não se copia a aprovação para os arquivos novos.
//
// Sem IA (só a detecção pelo texto). Sessões: REVSIGN_USER_* (dono do REVSIGN_API_TOKEN) e REVSIGN_ADMIN_*. Ver
// revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';

import {
  api,
  assertNoPaidGeminiCalls,
  BASE_URL,
  db,
  ensureInvoiceAccounts,
  invoicePdfFile,
  makeAccessKey,
  retryCreateOnStaleSocket,
  signIn,
  trpcAs,
} from './helpers.mjs';

assertNoPaidGeminiCalls();

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };
const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-refazer-'));

let userCookie;

const data = (res) => res.body?.result?.data?.json;
const invoice = (kind, name, input) => trpcAs(userCookie, kind, `revalle.invoice.${name}`, input);

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

const contract = () => {
  const file = path.join(mkdtempSync(path.join(tmp, 'c-')), 'contrato.pdf');

  copyFileSync('assets/example.pdf', file);

  return file;
};

const newEnvelopeWithFiles = async (files, label) => {
  const apiToken = process.env.REVSIGN_API_TOKEN;
  const form = new FormData();

  form.append(
    'payload',
    JSON.stringify({
      title: `[TESTE NF] refazer linhas ${label} ${RUN}`,
      type: 'DOCUMENT',
      meta: { distributionMethod: 'NONE' },
      recipients: [
        {
          role: 'SIGNER',
          name: 'Teste',
          email: `refazer-${label}-${RUN}@revalle.com.br`,
          fields: files.map((_, identifier) => ({
            type: 'SIGNATURE',
            identifier,
            page: 1,
            positionX: 10,
            positionY: 80,
            width: 30,
            height: 8,
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
      headers: { Authorization: `Bearer ${apiToken}` },
      body: form,
    });

    return { status: res.status, body: await res.json() };
  });

  assert.equal(created.status, 200, JSON.stringify(created.body));

  return created.body.id;
};

const classify = async (envelopeId) => {
  const res = await invoice('mutation', 'classify', { envelopeId });

  assert.equal(res.status, 200, res.text);

  return data(res);
};

const choose = async (envelopeId, code = '2.1.03', costCenter = '101') => {
  const account = await invoice('mutation', 'setChoice', { envelopeId, choice: { code } });

  assert.equal(account.status, 200, account.text);

  const center = await invoice('mutation', 'setCostCenter', { envelopeId, code: costCenter });

  assert.equal(center.status, 200, center.text);
};

const fileRows = (envelopeId) =>
  db(
    `select i."order" || ';' || f.kind || ';' || coalesce(f."choiceCode", '-') || ';' || coalesce(f."costCenterCode", '-')
     from "RevalleInvoiceFile" f join "EnvelopeItem" i on i.id = f."envelopeItemId"
     where f."envelopeId" = '${envelopeId}' order by i."order"`,
  );
const fileCount = (envelopeId) => db(`select count(*) from "RevalleInvoiceFile" where "envelopeId" = '${envelopeId}'`);
const mirror = (envelopeId, column) =>
  db(`select ${column} from "RevalleInvoiceClassification" where "envelopeId" = '${envelopeId}'`);

// Envio de antes da Fase 9, de dois arquivos (contrato + DANFE): classificado, com conta e centro, enviado, sem linhas.
const sentLegacy = async (label) => {
  const danfe = invoicePdfFile({ variant: `nf-${label}`, accessKey: makeAccessKey() });
  const id = await newEnvelopeWithFiles([contract(), danfe], label);

  assert.equal((await classify(id)).isInvoice, 'YES');
  await choose(id);

  const sent = await api('POST', '/envelope/distribute', { envelopeId: id });

  assert.equal(sent.status, 200, sent.text);
  db(`delete from "RevalleInvoiceFile" where "envelopeId" = '${id}'`);
  assert.equal(fileCount(id), '0');

  return id;
};

const REBUILT = '1;OTHER;-;-\n2;NF;2.1.03;101';

sessionTest('envio antigo de dois arquivos: a leitura refaz as linhas e o espelho fica igual', async () => {
  const id = await sentLegacy('leitura');

  assert.equal(mirror(id, `"choiceCode" || ';' || "costCenterCode"`), '2.1.03;101');

  const state = await invoice('query', 'get', { envelopeId: id });

  assert.equal(state.status, 200, state.text);
  assert.equal(fileRows(id), REBUILT);
  assert.equal(mirror(id, `"choiceCode" || ';' || "costCenterCode"`), '2.1.03;101');
});

sessionTest('envio antigo: o arquivo "outro" refeito já tem as chaves de acesso do texto', async () => {
  // Dois DANFEs: a nota refeita é o primeiro; o segundo vira "outro" e precisa ter a chave dele (se o remetente marcar
  // como nota depois, a duplicada já a encontra).
  const firstKey = makeAccessKey();
  const secondKey = makeAccessKey();
  const id = await newEnvelopeWithFiles(
    [
      invoicePdfFile({ variant: 'nf-primeira', accessKey: firstKey }),
      invoicePdfFile({ variant: 'nf-segunda', accessKey: secondKey }),
    ],
    'chaves',
  );

  assert.equal((await classify(id)).isInvoice, 'YES');
  await choose(id);
  // Forja o legado: enviado e sem linhas, com uma nota só (o espelho com a escolha).
  db(`delete from "RevalleInvoiceFile" where "envelopeId" = '${id}'`);
  db(`update "Envelope" set status = 'PENDING' where id = '${id}'`);

  const state = await invoice('query', 'get', { envelopeId: id });

  assert.equal(state.status, 200, state.text);
  assert.equal(
    db(
      `select count(*) from "RevalleInvoiceFile" where "envelopeId" = '${id}' and kind = 'OTHER' and '${secondKey}' = any("accessKeys")`,
    ),
    '1',
  );
});

sessionTest('backfill da subida: refaz o envio antigo e não pega de novo o que não tem o que refazer', async (t) => {
  if (!process.env.REVSIGN_RESTART_CMD) {
    t.skip('REVSIGN_RESTART_CMD (reinicia o app; o bootstrap roda o backfill) não definido');

    return;
  }

  const id = await sentLegacy('subida');
  // Envio sem arquivo nenhum (nota enviada cujos itens sumiram): nada a refazer.
  const empty = await sentLegacy('vazio');

  db(`delete from "EnvelopeItem" where "envelopeId" = '${empty}'`);
  assert.equal(fileCount(empty), '0');

  execSync(process.env.REVSIGN_RESTART_CMD, { stdio: 'ignore' });

  const deadline = performance.now() + 120_000;

  while (fileCount(id) === '0' && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  assert.equal(fileRows(id), REBUILT);
  assert.equal(fileCount(empty), '0');
});

const draftLegacy = async (label) => {
  const danfe = invoicePdfFile({ variant: `nf-${label}`, accessKey: makeAccessKey() });
  const id = await newEnvelopeWithFiles([contract(), danfe], label);

  assert.equal((await classify(id)).isInvoice, 'YES');
  await choose(id);
  // Rascunho de antes da Fase 9: sem linhas de arquivo.
  db(`delete from "RevalleInvoiceFile" where "envelopeId" = '${id}'`);

  return id;
};

sessionTest('allowDraft: com os mesmos arquivos refaz as linhas e mantém a escolha', async () => {
  const id = await draftLegacy('rascunho-igual');

  // A classificação do rascunho (mesmos arquivos) refaz sem apagar a escolha.
  await classify(id);

  assert.equal(fileRows(id), REBUILT);
  assert.equal(mirror(id, `"choiceCode" || ';' || "costCenterCode"`), '2.1.03;101');
});

sessionTest('allowDraft: com o arquivo trocado pelo dono não copia a escolha para os arquivos novos', async () => {
  const id = await draftLegacy('rascunho-troca');

  // O dono trocou o arquivo: a chave do conjunto da classificação não bate mais com os arquivos.
  db(`update "RevalleInvoiceClassification" set "fileSha256" = repeat('0', 64) where "envelopeId" = '${id}'`);
  await classify(id);

  const nfWithChoice = db(
    `select count(*) from "RevalleInvoiceFile" where "envelopeId" = '${id}' and "choiceCode" is not null`,
  );

  assert.equal(nfWithChoice, '0', 'a escolha não pode ir para linhas de arquivos que o dono trocou');
});
