// REVALLE (Fase 7): chamado por `scripts/revalle/ui-check-f7.mjs` (ver `shared.mjs`). As telas novas da Fase 7 em 390 px e
// 1280 px.
//
// Entrada: a URL, o time, as sessões do remetente e da Contabilidade, um rascunho de NF por largura, a NF enviada e o
// número que o contador da Contabilidade tem de mostrar.
import { finish, openAs, payload, report, section, shot } from './shared.mjs';

const { baseUrl, teamUrl, senderCookie, accountantCookie, drafts, sentId, pending } = payload;

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
];
const CENTERS = ['101 – Puxada', '201 – Armazém', '301 – Administrativo', '401 – Vendas', '501 – Entrega'];

const badgeLabel = (total) =>
  total === 1 ? '1 nota fiscal aguardando você' : `${total} notas fiscais aguardando você`;

// O bloco cabe na tela. O editor do upstream não é feito para celular (a página dele passa da largura da tela), então no
// diálogo de envio vale o bloco, e nas telas do RevSign, a página inteira.
const assertFits = async (locator, width, label) => {
  const box = await locator.boundingBox();

  report(Boolean(box) && box.x >= 0 && box.x + box.width <= width + 1, `${label}: cabe nos ${width} px`);
};

const assertNoHorizontalScroll = async (page, label) => {
  const { scrollWidth, width } = await page.evaluate(() => ({
    scrollWidth: document.scrollingElement.scrollWidth,
    width: window.innerWidth,
  }));

  report(scrollWidth <= width, `${label}: sem rolagem horizontal (${scrollWidth} de ${width} px)`);
};

// O estado da NF segundo o servidor (`revalle.invoice.get`, com a sessão do contexto), quando a sugestão deixa de estar em
// andamento: só então a lista de duplicadas é a final.
const settledState = async (context, page, envelopeId) => {
  const url = `${baseUrl}/api/trpc/revalle.invoice.get?input=${encodeURIComponent(JSON.stringify({ json: { envelopeId } }))}`;
  const deadline = performance.now() + 40_000;

  for (;;) {
    const state = (await (await context.request.get(url)).json())?.result?.data?.json;

    if (state && state.suggestionStatus !== 'PENDING') {
      return state;
    }

    if (performance.now() > deadline) {
      throw new Error('a sugestão não assentou em 40 s');
    }

    await page.waitForTimeout(500);
  }
};

const waitSubmit = async (submit, isEnabled) => {
  await submit.page().waitForLoadState('networkidle');

  try {
    await submit
      .page()
      .waitForFunction(([element, wanted]) => element.disabled !== wanted, [await submit.elementHandle(), isEnabled], {
        timeout: 10_000,
      });
  } catch {
    // o relatório mostra o que ficou
  }

  return await submit.isDisabled();
};

const chooseAccount = async (panel) => {
  await panel.locator('ul button').first().click();
  await panel.getByText(/Conta escolhida:/).waitFor();
};

const chooseCenter = async (page, panel) => {
  await panel.getByTestId('invoice-cost-center').click();

  const options = await page.getByRole('option').allInnerTexts();

  report(
    JSON.stringify(options.map((text) => text.trim())) === JSON.stringify(CENTERS),
    `o seletor lista os 5 centros (${options.length})`,
  );
  await page.getByRole('option', { name: CENTERS[0] }).click();
  await panel.getByText('Escolha o centro de custo.').waitFor({ state: 'detached' });
};

for (const viewport of VIEWPORTS) {
  const { width } = viewport;
  const isPhone = width < 640;

  await section(`${width} px, diálogo de envio`, async () => {
    const { context, page } = await openAs(senderCookie, viewport);

    await page.goto(`${baseUrl}/t/${teamUrl}/documents/${drafts[width]}/edit`, { waitUntil: 'networkidle' });
    await page
      .getByRole('button', { name: /enviar documento/i })
      .filter({ visible: true })
      .first()
      .click();

    const dialog = page.getByRole('dialog');
    const panel = dialog.getByTestId('invoice-account-panel');

    await panel.waitFor();
    await panel.getByText('Buscando sugestão…').waitFor({ state: 'detached', timeout: 40_000 });

    const submit = dialog.locator('button[type="submit"]');

    report(await panel.getByTestId('invoice-cost-center').isVisible(), `${width} px: o bloco tem o seletor de centro`);
    report(
      !/Deixar para o Financeiro|A definir/i.test(await dialog.innerText()),
      `${width} px: sem "Deixar para o Financeiro"`,
    );
    report(await waitSubmit(submit, false), `${width} px: Enviar desabilitado sem conta e sem centro`);
    await assertFits(panel, width, `${width} px, bloco da NF`);
    await shot(page, `${width}-01-envio-sem-escolha`);

    // A ordem muda de uma largura para a outra: cada metade da regra é vista sozinha.
    if (isPhone) {
      await chooseCenter(page, panel);
      report(await waitSubmit(submit, false), `${width} px: só com o centro, Enviar continua desabilitado`);
      await shot(page, `${width}-02-envio-so-centro`);
      await chooseAccount(panel);
    } else {
      await chooseAccount(panel);
      report(await waitSubmit(submit, false), `${width} px: só com a conta, Enviar continua desabilitado`);
      await shot(page, `${width}-02-envio-so-conta`);
      await chooseCenter(page, panel);
    }

    // Fase 8: a nota fictícia repete notas enviadas por execuções anteriores, então o alerta de nota duplicada aparece e o
    // Enviar espera pela confirmação, como para a pessoa. Quem decide se o alerta tem de existir é o estado do servidor, lido
    // depois que a sugestão assentou (a chave da IA chega junto com ela); a tela é que espera por ele, sem um `isVisible()`
    // num instante qualquer.
    const settled = await settledState(context, page, drafts[width]);
    const acknowledge = dialog.getByTestId('invoice-duplicate-ack');

    if (settled.duplicates.length > 0) {
      await acknowledge.waitFor();
      report(
        await waitSubmit(submit, false),
        `${width} px: com a conta e o centro, o alerta de nota duplicada ainda segura o Enviar`,
      );
      await acknowledge.click();
    } else {
      report((await acknowledge.count()) === 0, `${width} px: sem duplicada no servidor, a tela não mostra o alerta`);
    }

    report(!(await waitSubmit(submit, true)), `${width} px: com a conta e o centro, Enviar habilita`);
    await assertFits(panel, width, `${width} px, bloco da NF preenchido`);
    await submit.scrollIntoViewIfNeeded();
    await shot(page, `${width}-03-envio-pronto`);
    await context.close();
  });

  await section(`${width} px, contador no menu`, async () => {
    const { context, page } = await openAs(accountantCookie, viewport);

    await page.goto(`${baseUrl}/notas-fiscais`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('invoices-page').waitFor();
    await page.waitForLoadState('networkidle');

    if (isPhone) {
      await page.locator('button:has(svg.lucide-menu)').filter({ visible: true }).first().click();
    }

    const link = page.locator('a[href="/notas-fiscais"]').filter({ visible: true }).first();
    const badge = link.getByTestId('invoices-nav-badge');

    await badge.waitFor({ timeout: 20_000 });
    report(
      (await badge.getAttribute('aria-label')) === badgeLabel(pending),
      `${width} px: o contador diz "${badgeLabel(pending)}"`,
    );
    report(
      (await badge.textContent())?.trim() === (pending > 99 ? '99+' : String(pending)),
      `${width} px: o contador mostra o número`,
    );
    // O menu do celular anima ao abrir.
    await page.waitForTimeout(700);
    await assertNoHorizontalScroll(page, `${width} px, Notas fiscais`);
    await shot(page, `${width}-04-contador`);
    await context.close();
  });

  await section(`${width} px, cartão da Contabilidade`, async () => {
    const { context, page } = await openAs(accountantCookie, viewport);

    await page.goto(`${baseUrl}/notas-fiscais/${sentId}`, { waitUntil: 'domcontentloaded' });

    const card = page.getByTestId('accounting-card');

    await card.waitFor();
    report(
      (await card.getByTestId('accounting-card-center').textContent())?.trim() === CENTERS[0],
      `${width} px: o cartão mostra o centro`,
    );
    report(
      (await card.getByTestId('accounting-card-situation').textContent())?.trim() === 'Aguardando validação',
      `${width} px: o cartão diz "Aguardando validação"`,
    );
    report(
      await card.getByRole('button', { name: 'Validar centro de custo' }).isVisible(),
      `${width} px: o cartão tem "Validar centro de custo"`,
    );

    const change = card.getByRole('button', { name: 'Corrigir centro de custo' });

    report(await change.isVisible(), `${width} px: o cartão tem "Corrigir centro de custo"`);
    await assertNoHorizontalScroll(page, `${width} px, página da NF`);
    await card.scrollIntoViewIfNeeded();
    await shot(page, `${width}-05-cartao-contabilidade`);

    await change.click();

    const dialog = page.getByTestId('accounting-change-dialog');

    await dialog.waitFor();
    report(
      (await dialog.getByTestId('accounting-change-warning').textContent())?.includes(
        'Todos vão precisar assinar de novo',
      ),
      `${width} px: a correção avisa que todos assinam de novo`,
    );
    await assertFits(dialog, width, `${width} px, diálogo da correção`);
    await shot(page, `${width}-06-corrigir-centro`);
    await dialog.getByRole('button', { name: /cancelar/i }).click();
    await context.close();
  });

  await section(`${width} px, cadastro`, async () => {
    const { context, page } = await openAs(undefined, viewport);

    await page.goto(`${baseUrl}/signup`, { waitUntil: 'networkidle' });

    const cpf = page.getByLabel('CPF', { exact: true });
    const birthDate = page.getByLabel('Data de nascimento', { exact: true });

    await cpf.waitFor();
    report(await cpf.isVisible(), `${width} px: o cadastro pede o CPF`);
    report(await birthDate.isVisible(), `${width} px: o cadastro pede a data de nascimento`);
    await assertNoHorizontalScroll(page, `${width} px, cadastro`);
    await shot(page, `${width}-07-cadastro`, { fullPage: true });
    await context.close();
  });
}

await finish();
