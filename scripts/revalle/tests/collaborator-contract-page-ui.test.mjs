// v.22: a página "Contratos para colaboradores" no navegador (spec 2026-11-23-contrato-colaboradores-pagina-design.md,
// "Como fica"). Casos:
//   - o assistente completo: título, PDF, arrastar o quadro verde, representante, lista colada com erros na prévia,
//     a lista mudada e Continuar na hora (confere de novo antes de seguir), revisar e enviar com a confirmação; o
//     contrato fica "Aguardando representante" com só as linhas prontas;
//   - rascunho: só nasce com o PDF; o assistente fechado no meio fica como rascunho (nada enviado), continua pela lista
//     e é excluído pela lista; no celular o passo 1 pede uma tela maior;
//   - subir arquivo: .xlsx com o CPF numérico sem o zero à esquerda e .csv em Windows-1252 com acentos;
//   - a página de acompanhamento a 1280 e a 390 px, sem rolagem lateral (tabela no computador, cartões no celular);
//   - a conta comum não vê o item no menu, as páginas mandam para o início e o PDF do rascunho responde 403 (401 sem
//     sessão).
//
// Roda contra a stack local, com a imagem do Playwright (sem ela, os casos são pulados). Sessões: REVSIGN_ADMIN_*
// (rsadmin, ADMIN) e REVSIGN_USER_* (admin@hml.local, conta comum), de bootstrap-creds.mjs. Pessoas fictícias de
// revalle/colaboradores/dev-seed.sql. O representante recebe um convite (Mailpit); ninguém assina. Prints em
// REVSIGN_CONTRATO_SHOTS (pasta já criada), quando definido. Nunca imprime CPF, senha nem token.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { buildWin1252Csv, buildXlsx } from './fixtures/collaborator-list-files.mjs';
import {
  BASE_URL,
  db,
  hasPlaywrightImage,
  PLAYWRIGHT_IMAGE,
  runBrowserScript,
  signIn,
  textPdfBuffer,
  trpcAs,
} from './helpers.mjs';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };
const SHOT_DIR = process.env.REVSIGN_CONTRATO_SHOTS;

// Colaboradoras da base fictícia (ativas) e um CPF válido fora da base.
const MARIA_CPF = '390.533.447-05';
const FERNANDO_CPF = '93457210888';
const JOAO_CPF = '52871936455';
const NOT_IN_BASE_CPF = '529.982.247-25';
// CPF válido que começa com zero (fora da base): numa célula numérica do Excel vira 1234567890.
const LEADING_ZERO_CPF = 1234567890;

const title = `[TESTE] contrato pela tela ${RUN}`;
const draftTitle = `[TESTE] rascunho pela tela ${RUN}`;
const fileDraftTitle = `[TESTE] lista por arquivo ${RUN}`;
const repEmail = `contrato-ui-rep-${RUN}@revalle.com.br`;

// Com cabeçalho e colunas fora de ordem: 2 prontas, 1 e-mail inválido, 1 CPF fora da base, 1 CPF repetido.
const LIST = [
  'CPF;e-mail;nome',
  `${MARIA_CPF};contrato-ui-a-${RUN}@revalle.com.br;Maria Teste`,
  `${FERNANDO_CPF};contrato-ui-b-${RUN}@revalle.com.br;Fernando Teste`,
  `${JOAO_CPF};email-sem-arroba;João Teste`,
  `${NOT_IN_BASE_CPF};contrato-ui-fora-${RUN}@revalle.com.br;Fora da Base`,
  `${MARIA_CPF};contrato-ui-c-${RUN}@revalle.com.br;Maria de Novo`,
].join('\n');

// A mesma lista sem o Fernando: depois de mudar a caixa, só a Maria fica pronta.
const LIST_AFTER_EDIT = LIST.split('\n')
  .filter((line) => !line.includes('Fernando'))
  .join('\n');

const REP_RECT = { page: 1, positionX: 10, positionY: 70, width: 30, height: 8 };
const COLAB_RECT = { page: 1, positionX: 55, positionY: 70, width: 30, height: 8 };

const data = (res) => res.body?.result?.data?.json;

const uploadPdf = async (cookie) => {
  const form = new FormData();

  form.append(
    'file',
    new File([textPdfBuffer(['Contrato da tela', RUN])], 'contrato.pdf', { type: 'application/pdf' }),
  );

  const res = await fetch(`${BASE_URL}/api/files/upload-pdf`, {
    method: 'POST',
    headers: { Origin: new URL(BASE_URL).origin, Cookie: cookie },
    body: form,
  });

  assert.equal(res.status, 200, `upload: HTTP ${res.status}`);

  return (await res.json()).id;
};

let adminCookie;
let userCookie;
let createdContractId;

const runCase = async (t, browserCase, extra = {}) => {
  const browser = await runBrowserScript({
    script: 'collaborator-contract-page-ui.browser.mjs',
    payload: { baseUrl: BASE_URL, case: browserCase, ...extra },
    shotDir: SHOT_DIR,
    timeout: 300_000,
  });

  t.diagnostic(browser.stdout);
  assert.equal(browser.status, 0, `${browser.stdout}\n${browser.stderr}`);
};

const uiTest = (name, fn) =>
  test(name, async (t) => {
    if (!adminCookie || !userCookie) {
      t.skip('credenciais de sessão não informadas');

      return;
    }

    if (!hasPlaywrightImage()) {
      t.skip(`imagem ${PLAYWRIGHT_IMAGE} ausente no Docker (docker pull ${PLAYWRIGHT_IMAGE})`);

      return;
    }

    await fn(t);
  });

const contractRow = (where) =>
  db(
    `select id || '|' || status || '|' || coalesce("representativeEnvelopeId", '') || '|' || coalesce("collaboratorRect"::text, '') from "RevalleCollaboratorContract" where ${where} order by "createdAt" desc limit 1`,
  );

before(async () => {
  if (!user.email || !user.password || !admin.email || !admin.password) {
    return;
  }

  adminCookie = await signIn(admin.email, admin.password);
  userCookie = await signIn(user.email, user.password);
});

uiTest('assistente: colar a lista, ver os erros na prévia e enviar para o representante', async (t) => {
  // O resumo esperado vem da própria conferência (a mesma rota que a tela chama).
  const preview = await trpcAs(adminCookie, 'mutation', 'revalle.collaboratorContract.page.previewRows', {
    text: LIST,
  });

  assert.equal(preview.status, 200, preview.text);

  const { ready, withErrors, duplicates } = data(preview);

  assert.equal(ready, 2, 'Maria e Fernando prontos');

  await runCase(t, 'wizard', {
    adminCookie,
    title,
    repEmail,
    list: LIST,
    listAfterEdit: LIST_AFTER_EDIT,
    expectedSummary: `${ready} prontos · ${withErrors} com erro · ${duplicates} repetidos`,
    expectedReady: ready,
  });

  const row = contractRow(`title = '${title.replace(/'/g, "''")}'`);

  assert.ok(row, 'o contrato não foi criado');

  const [id, status, repEnvelopeId, collaboratorRect] = row.split('|');

  createdContractId = id;
  assert.equal(status, 'AWAITING_REPRESENTATIVE');
  assert.ok(repEnvelopeId, 'sem o documento do representante');

  // O quadro verde foi arrastado para a esquerda (começa em x 56) e continua dentro da página.
  const rect = JSON.parse(collaboratorRect);

  assert.ok(rect.positionX < 50, `o quadro verde não saiu do lugar: ${collaboratorRect}`);
  assert.ok(
    rect.positionX >= 0 && rect.positionX + rect.width <= 100.001,
    `quadro fora da página: ${collaboratorRect}`,
  );

  // Só as linhas prontas da lista mudada (a Maria) foram guardadas para virar documento.
  assert.equal(
    Number(db(`select coalesce(sum("totalRows"), 0) from "RevalleBulkSendUpload" where "contractId" = '${id}'`)),
    1,
  );
});

uiTest('rascunho: fechar o assistente no meio, nada é enviado, e continuar pela lista', async (t) => {
  await runCase(t, 'draft', { adminCookie, title: draftTitle });

  const row = contractRow(`title = '${draftTitle.replace(/'/g, "''")}'`);

  assert.ok(row, 'o rascunho não foi gravado');

  const [id, status, repEnvelopeId] = row.split('|');

  assert.equal(status, 'DRAFT');
  assert.equal(repEnvelopeId, '', 'o rascunho não pode ter documento do representante');
  assert.equal(Number(db(`select count(*) from "RevalleBulkSendUpload" where "contractId" = '${id}'`)), 0);

  // O PDF do rascunho é só do administrador.
  const pdfAsUser = await fetch(`${BASE_URL}/contratos-colaboradores/pdf/${id}`, {
    headers: { Cookie: userCookie },
    redirect: 'manual',
  });

  assert.equal(pdfAsUser.status, 403);

  const pdfAnonymous = await fetch(`${BASE_URL}/contratos-colaboradores/pdf/${id}`, { redirect: 'manual' });

  assert.equal(pdfAnonymous.status, 401);

  // Continua pela lista e, no fim, exclui o rascunho pela lista.
  await runCase(t, 'resume', { adminCookie, title: draftTitle, draftId: id });

  assert.equal(Number(db(`select count(*) from "RevalleCollaboratorContract" where id = '${id}'`)), 0);
});

uiTest('subir arquivo: .xlsx com CPF numérico e .csv em Windows-1252', async (t) => {
  // Rascunho pronto até o representante: o assistente abre no passo Colaboradores.
  const documentDataId = await uploadPdf(adminCookie);
  const draft = await trpcAs(adminCookie, 'mutation', 'revalle.collaboratorContract.page.saveDraft', {
    data: {
      title: fileDraftTitle,
      documentDataId,
      representativeEmail: repEmail,
      representativeRect: REP_RECT,
      collaboratorRect: COLAB_RECT,
    },
  });

  assert.equal(draft.status, 200, draft.text);

  const draftId = data(draft).contractId;

  const xlsx = buildXlsx([
    ['nome', 'e-mail', 'CPF'],
    ['Maria Teste', `contrato-ui-xa-${RUN}@revalle.com.br`, Number(MARIA_CPF.replace(/\D/g, ''))],
    ['Zero à Esquerda', `contrato-ui-xz-${RUN}@revalle.com.br`, LEADING_ZERO_CPF],
  ]);
  const csv = buildWin1252Csv([
    ['e-mail', 'nome', 'CPF'],
    [`contrato-ui-cf-${RUN}@revalle.com.br`, 'Fernando Ação', FERNANDO_CPF],
    [`contrato-ui-cj-${RUN}@revalle.com.br`, 'João Conceição', NOT_IN_BASE_CPF],
  ]);

  try {
    await runCase(t, 'file-upload', {
      adminCookie,
      draftId,
      xlsxBase64: xlsx.toString('base64'),
      csvBase64: csv.toString('base64'),
    });
  } finally {
    const removed = await trpcAs(adminCookie, 'mutation', 'revalle.collaboratorContract.page.deleteDraft', {
      contractId: draftId,
    });

    assert.equal(removed.status, 200, removed.text);
  }
});

uiTest('acompanhamento a 1280 e 390 px, sem rolagem lateral', async (t) => {
  assert.ok(createdContractId, 'depende do caso do assistente');

  // Um contrato com documentos na fila (de outro teste, se houver) para ver a tabela e os cartões.
  const withRows =
    db(
      `select c.id from "RevalleCollaboratorContract" c where exists (select 1 from "RevalleBulkSendQueue" q where q."contractId" = c.id) order by c."createdAt" desc limit 1`,
    ) || null;

  await runCase(t, 'tracking', { adminCookie, contractId: createdContractId, withRowsId: withRows });
});

uiTest('conta comum: sem item no menu e as páginas mandam para o início', async (t) => {
  await runCase(t, 'non-admin', { userCookie, contractId: createdContractId ?? 'contrato-inexistente' });
});
