// REVALLE (v.22): chamado por `collaborator-contract-page-ui.test.mjs` (ver `shared.mjs`). Confere, no navegador, a página
// "Contratos para colaboradores": o assistente (PDF, quadros, representante, lista colada com erros, revisar e enviar),
// o rascunho retomado pela lista, a página de acompanhamento a 1280 e 390 px e a conta comum sem acesso.
//
// Entrada: a URL e o caso (`case`): 'wizard' (adminCookie, title, repEmail, list, listAfterEdit, expectedSummary,
// expectedReady), 'draft' (adminCookie, title), 'resume' (adminCookie, title, draftId), 'file-upload' (adminCookie,
// draftId, xlsxBase64, csvBase64), 'tracking' (adminCookie, contractId, withRowsId ou null) ou 'non-admin'
// (userCookie, contractId). Partes que não dá para conferir (sem contrato com documentos) saem como "PULADO".

import { finish, openAs, payload, report, section, shot } from './shared.mjs';

const { baseUrl } = payload;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const PDF = 'assets/example.pdf';
const MENU_LABEL = 'Contratos para colaboradores';

const visit = async (page, route) => {
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
};

const noSideScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();

const isVisibleSoon = (locator, timeout = 30_000) =>
  locator.waitFor({ timeout }).then(
    () => true,
    () => false,
  );

const focusedTestId = (page) => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);

const skipped = (message) => console.log(`PULADO ${message}`);

const waitSaved = (page) => page.getByTestId('wizard-save-state').filter({ hasText: 'Rascunho salvo' }).waitFor();

// O quadro na tela, em % da camada sobre a página do PDF.
const boxOnPage = async (page, kind) => {
  const box = await page.getByTestId(`signature-box-${kind}`).boundingBox();
  const overlay = await page.getByTestId('contract-pdf-overlay').boundingBox();

  return {
    x: ((box.x - overlay.x) / overlay.width) * 100,
    right: ((box.x + box.width - overlay.x) / overlay.width) * 100,
  };
};

const uploadContract = async (page, title) => {
  await page.getByTestId('contract-title').fill(title);
  await page.getByTestId('contract-pdf-input').setInputFiles(PDF);
  await page.getByTestId('signature-box-collaborator').waitFor();
  await page.getByTestId('signature-box-representative').waitFor();
};

if (payload.case === 'wizard') {
  const { adminCookie, title, repEmail, list, listAfterEdit, expectedSummary, expectedReady } = payload;
  const { page } = await openAs(adminCookie, DESKTOP);

  await section('menu e lista', async () => {
    await visit(page, '/contratos-colaboradores');

    const nav = page.getByRole('navigation', { name: 'Navegação principal' });
    const link = nav.getByRole('link', { name: MENU_LABEL, exact: true });

    report((await link.count()) === 1, 'o administrador vê "Contratos para colaboradores" no menu');
    report((await link.getAttribute('aria-current')) === 'page', 'o item fica marcado na página');

    await page.getByTestId('contracts-new').first().click();
    await page.getByTestId('contract-wizard').waitFor();
    report(page.url().includes('/contratos-colaboradores/novo'), 'Novo contrato abre o assistente');
  });

  await section('passo 1: contrato', async () => {
    // Continuar sem nada mostra o erro do título.
    await page.getByTestId('wizard-continue').click();
    report(
      (await page.getByRole('alert').filter({ hasText: 'Dê um título ao contrato.' }).count()) > 0,
      'sem título: "Dê um título ao contrato."',
    );

    await uploadContract(page, title);

    const start = await boxOnPage(page, 'collaborator');

    report(start.x > 50, `o quadro verde começa à direita (${start.x.toFixed(1)}%)`);

    // Arrasta o quadro verde 30% para a esquerda. O mouse do Playwright usa a parte visível da tela: o quadro começa
    // embaixo da página, fora dela, até rolar.
    await page.getByTestId('signature-box-collaborator').scrollIntoViewIfNeeded();

    const box = await page.getByTestId('signature-box-collaborator').boundingBox();
    const overlay = await page.getByTestId('contract-pdf-overlay').boundingBox();
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - overlay.width * 0.3, from.y, { steps: 12 });
    await page.mouse.up();

    const moved = await boxOnPage(page, 'collaborator');

    await shot(page, 'contrato-quadro-arrastado');

    report(Math.abs(moved.x - (start.x - 30)) <= 2, `o quadro verde foi arrastado (${moved.x.toFixed(1)}%)`);

    // Arrastar para fora não tira o quadro da página.
    const again = await page.getByTestId('signature-box-collaborator').boundingBox();

    await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
    await page.mouse.down();
    await page.mouse.move(again.x - overlay.width, again.y + again.height / 2, { steps: 8 });
    await page.mouse.up();

    const clamped = await boxOnPage(page, 'collaborator');

    report(clamped.x >= -0.5, `o quadro fica dentro da página (${clamped.x.toFixed(1)}%)`);

    // O teclado também move: o quadro azul com a seta para a direita.
    const blueBefore = await boxOnPage(page, 'representative');

    await page.getByTestId('signature-box-representative').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    const blueAfter = await boxOnPage(page, 'representative');

    report(blueAfter.x - blueBefore.x > 1, 'as setas movem o quadro azul');

    await waitSaved(page);
    report(/[?&]id=/.test(page.url()), 'o endereço passa a ter o rascunho');
    await shot(page, 'contrato-passo-1');

    await page.getByTestId('wizard-continue').click();
    await page.getByTestId('wizard-step-representative').waitFor();
    report((await focusedTestId(page)) === 'wizard-step-heading', 'o foco vai para o título do passo novo');
  });

  await section('passo 2: representante', async () => {
    await page.getByTestId('wizard-continue').click();
    report(
      (await page.getByRole('alert').filter({ hasText: 'Digite o e-mail do representante' }).count()) > 0,
      'sem e-mail: o erro diz o que fazer',
    );

    await page.getByTestId('representative-email').fill('alguem@gmail.com');
    await page.getByTestId('wizard-continue').click();
    report(
      (await page.getByRole('alert').filter({ hasText: 'use um e-mail' }).count()) > 0,
      'e-mail de fora: pede o e-mail da empresa',
    );

    await page.getByTestId('representative-email').fill(repEmail);
    report(
      (await text(page.getByTestId('wizard-step-representative'))).includes(
        'O representante recebe o contrato primeiro. Assim que ele assinar, o envio para os colaboradores começa sozinho.',
      ),
      'o texto de ajuda do representante aparece',
    );

    await page.getByTestId('wizard-continue').click();
    await page.getByTestId('wizard-step-collaborators').waitFor();
  });

  await section('passo 3: colaboradores', async () => {
    await page.getByTestId('collaborators-paste').fill(list);
    await page.getByTestId('collaborators-summary').waitFor({ timeout: 60_000 });

    const summary = await text(page.getByTestId('collaborators-summary'));

    report(summary === expectedSummary, `resumo "${summary}" (esperado "${expectedSummary}")`);
    report((await page.getByTestId('preview-row-ready').count()) === expectedReady, `${expectedReady} linhas verdes`);

    const preview = await text(page.getByTestId('collaborators-preview'));

    for (const issue of ['E-mail inválido', 'CPF não está na base do RH', 'CPF repetido na lista']) {
      report(preview.includes(issue), `a prévia mostra "${issue}"`);
    }

    report(!/39053344705|390\.533\.447-05/.test(preview), 'o CPF aparece mascarado na prévia');
    report(await page.getByTestId('collaborators-download-errors').isEnabled(), '"Baixar as linhas com erro" liberado');
    await shot(page, 'contrato-passo-3', { fullPage: true });

    // A caixa muda e Continuar vem logo em seguida (antes da pausa da conferência): a lista nova é conferida antes de
    // seguir, e a prévia velha nunca vai para o envio.
    await page.getByTestId('collaborators-paste').fill(listAfterEdit);
    await page.getByTestId('wizard-continue').click();
    await page.getByTestId('wizard-step-review').waitFor({ timeout: 60_000 });
  });

  await section('revisar e enviar', async () => {
    const collaborators = await text(page.getByTestId('review-collaborators'));

    report(/^1 colaborador(?!es)/.test(collaborators), `a lista mudada vale e no singular ("${collaborators}")`);
    report(
      (await text(page.getByTestId('review-subject'))) === `Revalle enviou "${title}" para você assinar`,
      'o assunto com o remetente padrão "Revalle"',
    );
    report((await text(page.getByTestId('review-estimate'))).includes('e-mails por hora'), 'a estimativa de envio');

    await page.getByTestId('wizard-send').click();

    const dialog = page.getByTestId('confirm-send-dialog');

    await dialog.waitFor();
    report(
      (await text(dialog)).includes('Enviar para o representante e, depois que ele assinar, para 1 colaborador?'),
      'a confirmação pergunta antes de enviar (singular)',
    );
    await shot(page, 'contrato-confirmar');

    await page.getByTestId('confirm-send').click();
    await page.getByTestId('contract-status-page').waitFor({ timeout: 60_000 });

    report(!page.url().includes('/novo'), `depois de enviar, a página do contrato (${new URL(page.url()).pathname})`);
    report(
      (await text(page.getByTestId('contract-status'))) === 'Aguardando representante',
      'o contrato fica "Aguardando representante"',
    );
    await shot(page, 'contrato-enviado');
  });
}

if (payload.case === 'draft') {
  const { adminCookie, title } = payload;
  const { page } = await openAs(adminCookie, DESKTOP);

  await section('fechar o assistente no meio', async () => {
    await visit(page, '/contratos-colaboradores/novo');

    // Só o título não cria rascunho (nada para continuar sem o PDF).
    await page.getByTestId('contract-title').fill(title);
    await page.waitForTimeout(2000);
    report(!/[?&]id=/.test(page.url()), 'sem o PDF, nenhum rascunho');

    await uploadContract(page, title);
    await waitSaved(page);
    report(/[?&]id=/.test(page.url()), 'com o PDF, o rascunho nasce');

    // Sai sem continuar: o rascunho fica na lista.
    await visit(page, '/contratos-colaboradores');

    const row = page.getByTestId('contracts-row').filter({ hasText: title });

    await row.waitFor();
    report((await row.getAttribute('data-status')) === 'DRAFT', 'o rascunho aparece na lista');
    report((await text(row)).includes('Montando'), 'com a situação "Montando"');
  });
}

if (payload.case === 'resume') {
  const { adminCookie, title, draftId } = payload;

  await section('continuar o rascunho pela lista', async () => {
    const { page } = await openAs(adminCookie, DESKTOP);

    await visit(page, '/contratos-colaboradores');
    await page.getByTestId('contracts-row').filter({ hasText: title }).getByRole('link').click();
    await page.getByTestId('contract-wizard').waitFor();

    report(page.url().includes(`id=${draftId}`), 'abre o assistente com o rascunho');
    report(
      await isVisibleSoon(page.getByTestId('wizard-step-representative')),
      'continua no primeiro passo que falta (Representante)',
    );

    await page.getByRole('button', { name: '1. Contrato' }).click();
    report((await page.getByTestId('contract-title').inputValue()) === title, 'o título voltou');
    report(
      await isVisibleSoon(page.getByTestId('signature-box-collaborator'), 60_000),
      'a prévia do PDF e os quadros voltaram',
    );
  });

  await section('celular: o passo 1 pede uma tela maior', async () => {
    const { page } = await openAs(adminCookie, PHONE);

    await visit(page, `/contratos-colaboradores/novo?id=${draftId}`);
    await page.getByTestId('wizard-step-representative').waitFor();
    await page.getByRole('button', { name: '1. Contrato' }).click();
    await page.getByTestId('contract-small-screen').waitFor();

    report(
      (await text(page.getByTestId('contract-small-screen'))) === 'Use uma tela maior para posicionar as assinaturas',
      'o aviso aparece no celular',
    );
    report(!(await page.getByTestId('contract-boxes-editor').isVisible()), 'os quadros não aparecem no celular');
    report(await noSideScroll(page), 'sem rolagem lateral no assistente a 390 px');
    await shot(page, 'contrato-celular-passo-1');
  });

  await section('excluir o rascunho pela lista', async () => {
    const { page } = await openAs(adminCookie, DESKTOP);

    await visit(page, '/contratos-colaboradores');

    const row = page.getByTestId('contracts-row').filter({ hasText: title });

    await row.getByTestId('contracts-delete-draft').click();
    await page.getByTestId('contracts-delete-dialog').waitFor();
    await page.getByTestId('contracts-delete-confirm').click();
    await row.waitFor({ state: 'detached' });
    report((await row.count()) === 0, 'o rascunho sai da lista');
  });
}

if (payload.case === 'file-upload') {
  const { adminCookie, draftId, xlsxBase64, csvBase64 } = payload;
  const { page } = await openAs(adminCookie, DESKTOP);

  const upload = async (name, mimeType, base64) => {
    await page
      .getByTestId('collaborators-file-input')
      .setInputFiles({ name, mimeType, buffer: Buffer.from(base64, 'base64') });
    await page.getByTestId('collaborators-file-name').filter({ hasText: name }).waitFor();
    await page.getByTestId('collaborators-preview').waitFor({ timeout: 60_000 });
    await page.getByTestId('collaborators-checking').waitFor({ state: 'hidden', timeout: 60_000 });
  };

  await section('planilha .xlsx', async () => {
    await visit(page, `/contratos-colaboradores/novo?id=${draftId}`);
    await page.getByTestId('wizard-step-collaborators').waitFor();
    await page.getByTestId('collaborators-tab-file').click();

    await upload('colaboradores.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsxBase64);

    const preview = await text(page.getByTestId('collaborators-preview'));

    report((await page.getByTestId('preview-row-ready').count()) === 1, '.xlsx: a Maria (CPF numérico) fica pronta');
    report(
      preview.includes('CPF não está na base do RH') && !preview.includes('CPF inválido'),
      '.xlsx: o CPF sem o zero à esquerda volta a ter 11 dígitos',
    );
    report(preview.includes('Zero à Esquerda'), '.xlsx: acentos do texto');
    await shot(page, 'contrato-arquivo-xlsx', { fullPage: true });
  });

  await section('planilha .csv em Windows-1252', async () => {
    await upload('colaboradores.csv', 'text/csv', csvBase64);

    const preview = await text(page.getByTestId('collaborators-preview'));

    report(preview.includes('Fernando Ação'), '.csv: acentos lidos (Windows-1252)');
    report(preview.includes('João Conceição'), '.csv: acentos na segunda linha');
    report((await page.getByTestId('preview-row-ready').count()) === 1, '.csv: o Fernando fica pronto');
    report(preview.includes('Arquivo colaboradores.csv'), 'a prévia diz de qual arquivo veio');
  });
}

if (payload.case === 'tracking') {
  const { adminCookie, contractId, withRowsId } = payload;

  for (const [label, viewport] of [
    ['1280', DESKTOP],
    ['390', PHONE],
  ]) {
    await section(`acompanhamento a ${label} px`, async () => {
      const { page } = await openAs(adminCookie, viewport);

      await visit(page, `/contratos-colaboradores/${contractId}`);
      await page.getByTestId('contract-stages').waitFor();

      report(
        await page.getByTestId('contract-resend-representative').isVisible(),
        `${label}: Reenviar para o representante`,
      );
      report(await page.getByTestId('contract-pause').isVisible(), `${label}: Pausar envio`);
      report(await noSideScroll(page), `${label}: sem rolagem lateral`);
      await shot(page, `contrato-acompanhamento-${label}`, { fullPage: true });

      // Pausar pede confirmação; cancelar não muda nada.
      await page.getByTestId('contract-pause').click();
      report(await isVisibleSoon(page.getByTestId('contract-pause-dialog')), `${label}: Pausar pede confirmação`);
      await page.getByRole('button', { name: 'Cancelar' }).click();
      await page.getByTestId('contract-pause-dialog').waitFor({ state: 'hidden' });

      if (withRowsId) {
        await visit(page, `/contratos-colaboradores/${withRowsId}`);

        const isPhone = viewport.width < 768;
        const list = page.getByTestId(isPhone ? 'contract-rows-cards' : 'contract-rows-table');

        await list.waitFor();
        report(
          !(await page.getByTestId(isPhone ? 'contract-rows-table' : 'contract-rows-cards').isVisible()),
          `${label}: ${isPhone ? 'cartões no lugar da tabela' : 'tabela no computador'}`,
        );
        report(!/\b\d{11}\b|\d{3}\.\d{3}\.\d{3}-\d{2}/.test(await text(list)), `${label}: CPF mascarado na lista`);
        report(await noSideScroll(page), `${label}: sem rolagem lateral com a lista`);

        await page.getByTestId('contract-filter-SIGNED').click();
        report(
          (await page.getByTestId('contract-filter-SIGNED').getAttribute('aria-pressed')) === 'true',
          `${label}: filtro "Assinado" marcado`,
        );
        await shot(page, `contrato-lista-${label}`, { fullPage: true });
      } else {
        skipped(`${label}: tabela/cartões (nenhum contrato com documentos na stack)`);
      }
    });
  }
}

if (payload.case === 'non-admin') {
  const { userCookie, contractId } = payload;

  await section('conta comum', async () => {
    const { page } = await openAs(userCookie, DESKTOP);

    await visit(page, '/notas-fiscais');

    const nav = page.getByRole('navigation', { name: 'Navegação principal' });

    await nav.waitFor();
    report((await nav.getByRole('link', { name: MENU_LABEL }).count()) === 0, 'sem o item no menu');

    for (const route of [
      '/contratos-colaboradores',
      '/contratos-colaboradores/novo',
      `/contratos-colaboradores/${contractId}`,
    ]) {
      await visit(page, route);
      report(
        !new URL(page.url()).pathname.startsWith('/contratos-colaboradores'),
        `${route} manda para o início (${new URL(page.url()).pathname})`,
      );
    }
  });
}

await finish();
