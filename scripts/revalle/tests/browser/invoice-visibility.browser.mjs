// REVALLE (Fase 7, Task 7): chamado por `invoice-visibility.test.mjs` e, na fase `owner-view`, por `acceptance-f7.test.mjs`
// (ver `shared.mjs`). As telas desenham o contador do menu, a fila de abertura da página "Notas fiscais" e o botão "View"
// no navegador (as consultas rodam lá), então só um navegador de verdade as vê.
//
// Entrada: as sessões, o que cada tela deve mostrar e as NFs de teste.
import { finish, openAs, payload, report, shot } from './shared.mjs';

const { phase = 'main', baseUrl, teamUrl, expected, cookies, own, received, validatedTitle } = payload;

const badgeLabel = (total) =>
  total === 1 ? '1 nota fiscal aguardando você' : `${total} notas fiscais aguardando você`;
const countText = (total) => (total === 1 ? '1 nota fiscal' : `${total} notas fiscais`);

const selectValue = (page, id) => page.locator(`#${id}`).inputValue();

const waitSelectValue = async (page, id, value) => {
  try {
    await page.waitForFunction(
      ([selector, wanted]) => document.querySelector(selector)?.value === wanted,
      [`#${id}`, value],
      { timeout: 20_000 },
    );
  } catch {
    // o relatório abaixo mostra o valor que ficou
  }

  return await selectValue(page, id);
};

// Abre a página das NFs e espera o perfil e a lista carregarem (a contagem aparece acima da tabela).
const openInvoices = async (cookie, query = '', viewport) => {
  const { context, page } = await openAs(cookie, viewport);
  const counts = page.waitForResponse((response) => response.url().includes('revalle.invoice.pendingCounts'));

  await page.goto(`${baseUrl}/notas-fiscais${query}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('invoices-page').waitFor();
  await counts.catch(() => undefined);
  // Perfis e lista carregam em consultas separadas: sem rede em andamento, o que a tela mostra já é o resultado delas.
  await page.waitForLoadState('networkidle');

  return { context, page };
};

const waitCount = async (page, total) => {
  try {
    await page.getByText(countText(total), { exact: true }).first().waitFor({ timeout: 20_000 });

    return true;
  } catch {
    return false;
  }
};

const badge = (page) => page.getByTestId('invoices-nav-badge');

// Botão "View" depois de assinar: na lista de documentos, quem tem o documento no próprio time vai à página dele.
const checkOwnerView = async () => {
  const { context, page } = await openAs(cookies.owner);

  await page.goto(`${baseUrl}/t/${teamUrl}/documents?query=${encodeURIComponent(own.title)}`, {
    waitUntil: 'domcontentloaded',
  });

  const row = page.getByRole('row').filter({ hasText: own.title });

  await row.first().waitFor();

  const viewLink = row.locator(`a[href="/t/${teamUrl}/documents/${own.id}"]`);

  report(
    (await viewLink.count()) > 0,
    'remetente que assinou: a lista de documentos tem o link para a página do documento',
  );
  report(
    (await row.locator('button[disabled]').count()) === 0,
    'remetente que assinou: nenhum botão desabilitado na linha',
  );
  await shot(page, '04-documentos-view');

  if ((await viewLink.count()) > 0) {
    await viewLink.first().click();
    await page.waitForURL(new RegExp(`/t/${teamUrl}/documents/${own.id}$`));
    report(true, 'o botão "View" abre a página do documento');
  }

  await context.close();
};

if (phase === 'owner-view') {
  await checkOwnerView();
}

if (phase === 'main') {
  // ---- Contabilidade: abre na fila dela, com o contador do menu ------------------------------------------------------
  {
    const { context, page } = await openInvoices(cookies.accountant);
    const pending = expected.accountant.accounting;

    report(
      (await waitSelectValue(page, 'invoices-accounting', 'pendentes')) === 'pendentes',
      'Contabilidade abre filtrada em "Aguardando a Contabilidade"',
    );
    report(
      (await selectValue(page, 'invoices-finance')) === '',
      'Contabilidade (sem Financeiro) não abre filtrada no Financeiro',
    );
    report(await waitCount(page, pending), `a fila da Contabilidade mostra ${countText(pending)}`);

    // A fila tem as notas sem validação e a nova versão com o envio parado ("não enviada"), que a Contabilidade também
    // envia de novo: essa pode vir validada (a correção do centro a valida).
    // Redesign v3: cada NF é um cartão; a etiqueta da Contabilidade só aparece quando o centro já foi validado
    // ("Centro validado"). Pendente ou sem centro não tem etiqueta: a pendência está na pílula de ação.
    const queueRows = await page
      .getByTestId('invoices-page')
      .getByTestId('invoice-row')
      .evaluateAll((rows) =>
        rows.map((row) => ({
          state: row.querySelector('[data-testid="invoice-row-accounting"]')?.textContent?.trim() ?? '',
          isUnsent: (row.textContent ?? '').includes('não enviada'),
        })),
      );
    const states = queueRows.map((row) => row.state || '(sem etiqueta)');

    report(
      queueRows.length > 0 &&
        queueRows.every((row) => row.state === '' || (row.isUnsent && row.state === 'Centro validado')),
      `a fila só tem notas sem validação e versões não enviadas (${[...new Set(states)].join(', ')})`,
    );

    const centers = await page.getByTestId('invoice-row-cost-center').allTextContents();

    report(
      centers.length === states.length && centers.some((text) => text.replace(/\s+/g, '') === '101Puxada'),
      'a etiqueta do centro de custo mostra "101 Puxada"',
    );
    await badge(page)
      .first()
      .waitFor({ timeout: 20_000 })
      .catch(() => undefined);
    report((await badge(page).count()) === 1, 'o menu tem um contador');
    report(
      (await badge(page).first().getAttribute('aria-label')) === badgeLabel(pending),
      `o contador diz "${badgeLabel(pending)}"`,
    );
    report(
      (await badge(page).first().textContent())?.trim() === (pending > 99 ? '99+' : String(pending)),
      'o contador mostra o número',
    );
    await shot(page, '01-contabilidade-fila');

    // "Todas" desliga o padrão e mostra também as validadas.
    await page.goto(`${baseUrl}/notas-fiscais?contabilidade=todas`, { waitUntil: 'domcontentloaded' });
    report(
      (await waitSelectValue(page, 'invoices-accounting', 'todas')) === 'todas',
      '?contabilidade=todas mostra "Todas"',
    );

    try {
      await page
        .getByTestId('invoice-row-accounting')
        .filter({ hasText: /^Centro validado$/ })
        .first()
        .waitFor({ timeout: 20_000 });
      report(true, '"Todas" mostra uma nota com "Centro validado"');
    } catch {
      report(false, '"Todas" mostra uma nota com "Centro validado"');
    }

    await shot(page, '02-contabilidade-todas');
    await context.close();
  }

  // ---- Financeiro: abre na fila dele ----------------------------------------------------------------------------------
  {
    const { context, page } = await openInvoices(cookies.financeOnly);
    const pending = expected.financeOnly.finance;

    report(
      (await waitSelectValue(page, 'invoices-finance', 'pendentes')) === 'pendentes',
      'Financeiro abre filtrado em "Aguardando o Financeiro"',
    );
    report(
      (await selectValue(page, 'invoices-accounting')) === '',
      'Financeiro (sem Contabilidade) não abre filtrado na Contabilidade',
    );
    report(await waitCount(page, pending), `a fila do Financeiro mostra ${countText(pending)}`);
    await badge(page)
      .first()
      .waitFor({ timeout: 20_000 })
      .catch(() => undefined);
    report(
      (await badge(page).first().getAttribute('aria-label')) === badgeLabel(pending),
      `o contador do Financeiro diz "${badgeLabel(pending)}"`,
    );
    await context.close();
  }

  // ---- Os dois perfis: abre na fila do Financeiro e o contador soma ----------------------------------------------------
  {
    const { context, page } = await openInvoices(cookies.both);
    const sum = expected.both.finance + expected.both.accounting;

    report(
      (await waitSelectValue(page, 'invoices-finance', 'pendentes')) === 'pendentes',
      'quem tem os dois perfis abre na fila do Financeiro',
    );
    report(
      (await selectValue(page, 'invoices-accounting')) === 'todas',
      'quem tem os dois perfis não abre com as duas filas juntas',
    );
    report(await waitCount(page, expected.both.finance), `a fila mostra ${countText(expected.both.finance)}`);
    await badge(page)
      .first()
      .waitFor({ timeout: 20_000 })
      .catch(() => undefined);
    report(
      (await badge(page).first().getAttribute('aria-label')) === badgeLabel(sum),
      `o contador soma as duas filas: "${badgeLabel(sum)}"`,
    );

    // Escolher a fila da Contabilidade desliga a do Financeiro.
    await page.locator('#invoices-accounting').selectOption('pendentes');
    report(
      (await waitSelectValue(page, 'invoices-finance', 'todas')) === 'todas',
      'escolher a fila da Contabilidade solta a do Financeiro',
    );
    report(
      await waitCount(page, expected.both.accounting),
      `a fila da Contabilidade mostra ${countText(expected.both.accounting)}`,
    );
    await context.close();
  }

  // ---- Sem perfil: nenhum contador, nenhuma fila ---------------------------------------------------------------------
  {
    const { context, page } = await openInvoices(cookies.outsider);

    report(
      (await selectValue(page, 'invoices-finance')) === '' && (await selectValue(page, 'invoices-accounting')) === '',
      'sem perfil não abre filtrado',
    );
    await page.waitForTimeout(1500);
    report((await badge(page).count()) === 0, 'sem perfil, o menu não tem contador');
    await context.close();
  }

  // ---- Celular: o contador no menu de 360 px ---------------------------------------------------------------------------
  {
    const { context, page } = await openInvoices(cookies.accountant, '', { width: 360, height: 740 });
    const pending = expected.accountant.accounting;

    await page.locator('button:has(svg.lucide-menu)').filter({ visible: true }).first().click();

    const link = page.locator('a[href="/notas-fiscais"]').filter({ visible: true }).first();

    await link.waitFor();
    await badge(link)
      .waitFor({ timeout: 20_000 })
      .catch(() => undefined);
    report(
      (await badge(link).first().getAttribute('aria-label')) === badgeLabel(pending),
      `no celular o menu mostra o contador "${badgeLabel(pending)}"`,
    );
    await page.waitForTimeout(700);
    await shot(page, '03-celular-menu');
    await context.close();
  }

  await checkOwnerView();

  // ---- Botão "View" depois de assinar: caixa de entrada de quem só recebeu --------------------------------------------------
  {
    const { context, page } = await openAs(cookies.outsider);

    await page.goto(`${baseUrl}/inbox?query=${encodeURIComponent(received.title)}`, { waitUntil: 'domcontentloaded' });

    const row = page.getByRole('row').filter({ hasText: received.title });

    await row.first().waitFor();

    const viewLink = row.locator(`a[href="/sign/${received.token}"]`);

    report(
      (await viewLink.count()) > 0,
      'quem só recebeu e assinou: a caixa de entrada tem o link para a página de conclusão',
    );
    report(
      (await row.locator('button[disabled]').count()) === 0,
      'quem só recebeu e assinou: nenhum botão desabilitado na linha',
    );
    await shot(page, '05-caixa-view');

    if ((await viewLink.count()) > 0) {
      await viewLink.first().click();
      await page.waitForURL(new RegExp(`/sign/${received.token}/complete$`));

      const open = page.getByTestId('complete-view-document').first();

      await open.waitFor();
      report((await open.getAttribute('target')) === '_blank', 'a página de conclusão tem "Ver documento" em nova aba');

      const response = await context.request.get(new URL(await open.getAttribute('href'), baseUrl).href);

      report(
        response.status() === 200 && (response.headers()['content-type'] ?? '').includes('application/pdf'),
        '"Ver documento" abre o PDF',
      );
      await shot(page, '06-conclusao-ver-documento');
    }

    await context.close();
  }

  // ---- Página da NF: o botão "Baixar PDF" ----------------------------------------------------------------------------------
  {
    const { context, page } = await openAs(cookies.accountant);

    await page.goto(`${baseUrl}/notas-fiscais/${own.id}`, { waitUntil: 'domcontentloaded' });

    const download = page.getByTestId('invoice-view-download').first();

    await download.waitFor();

    const href = (await download.getAttribute('href')) ?? '';

    report(
      new RegExp(`^/notas-fiscais/${own.id}/pdf/[^/?]+\\?download=1$`).test(href),
      'a página da NF tem o botão "Baixar PDF" com download=1',
    );
    await shot(page, '07-nf-baixar-pdf');
    await context.close();
  }
}

if (phase === 'admin-alert') {
  const { context, page } = await openAs(payload.adminCookie);

  await page.goto(`${baseUrl}/admin/revalle-perfis`, { waitUntil: 'domcontentloaded' });

  const alert = page.getByTestId('accounting-admin-alert');

  try {
    await alert.waitFor({ timeout: 20_000 });
    report(true, 'sem ninguém na Contabilidade e com nota esperando, a tela do admin avisa');
    report(
      ((await alert.textContent()) ?? '').includes(`aguardando a Contabilidade: ${payload.adminPending}.`),
      `o aviso traz o número de notas esperando (${payload.adminPending})`,
    );
    await shot(page, '08-admin-aviso');
  } catch {
    report(false, 'sem ninguém na Contabilidade e com nota esperando, a tela do admin avisa');
  }

  await context.close();
}

if (phase === 'admin-quiet') {
  const { context, page } = await openAs(payload.adminCookie);

  await page.goto(`${baseUrl}/admin/revalle-perfis`, { waitUntil: 'domcontentloaded' });
  // A lista carrega junto com a contagem de membros: espera uma linha antes de concluir que não há aviso.
  await page
    .getByRole('row')
    .nth(1)
    .waitFor({ timeout: 20_000 })
    .catch(() => undefined);
  report(
    (await page.getByTestId('accounting-admin-alert').count()) === 0,
    'com alguém na Contabilidade, a tela do admin não avisa',
  );
  await context.close();
}

if (phase === 'main' && validatedTitle === undefined) {
  report(false, 'o teste não mandou a NF validada');
}

await finish();
