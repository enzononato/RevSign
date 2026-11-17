// REVALLE (v.20): chamado por `invoice-annotation-box-ui.test.mjs` (ver `shared.mjs`). Confere, no navegador, o bloco
// "Conta e centro de custo": arrastar da paleta para a página, o lugar depois de recarregar, tirar o bloco, e a linha
// "No PDF: …" e o aviso em âmbar no diálogo de envio (sem rolagem lateral no celular de 390 px).
//
// Entrada: a URL, o time, a sessão do dono, o rascunho (`draftId`), o ponto onde soltar o bloco (`dropAt`, % da página)
// e o caso (`case`: 'drag', 'remove', 'contract' ou 'not-a-field').
import { finish, openAs, payload, report, section, shot } from './shared.mjs';

const { baseUrl, teamUrl, ownerCookie, draftId, dropAt } = payload;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 1000 };
// Tolerância da posição do bloco, em % da página.
const TOLERANCE = 2;

const LINE_WITH_BOX = 'No PDF: conta e centro na página 1.';
const LINE_WITHOUT_BOX = 'No PDF: sem conta e centro (opcional — coloque o bloco no passo Adicionar campos).';
const contractWarning = (title) => `O bloco de conta e centro em ${title} não será impresso: só sai em nota fiscal.`;

const normalized = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();

const pageImage = (page) => page.locator('.react-pdf__Page[data-page-number="1"]').first();

const openFieldsStep = async (page) => {
  await page.goto(`${baseUrl}/t/${teamUrl}/documents/${draftId}/edit?step=addFields`, { waitUntil: 'networkidle' });
  await page.getByTestId('envelope-editor-step-addFields').waitFor();
  await pageImage(page).waitFor();
  await page.locator('.konva-container canvas').first().waitFor({ state: 'attached' });
  await page.getByTestId('annotation-box-palette-button').waitFor();
};

const isBoxRoute = (name) => (res) =>
  res.url().includes(`revalle.invoice.annotationBox.${name}`) && res.request().method() === 'POST';

// Da paleta até o ponto `at` (% da página 1), com o mouse: o mesmo gesto da assinatura.
const dragBoxTo = async (page, at) => {
  await pageImage(page).scrollIntoViewIfNeeded();

  const button = await page.getByTestId('annotation-box-palette-button').boundingBox();
  const target = await pageImage(page).boundingBox();
  const saved = page.waitForResponse(isBoxRoute('set'));

  await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + (target.width * at.x) / 100, target.y + (target.height * at.y) / 100, { steps: 15 });
  await page.mouse.up();

  const res = await saved;

  report(res.ok(), `o bloco foi gravado ao soltar (HTTP ${res.status()})`);
};

// O bloco na tela, em % da página 1 (a moldura HTML sobre o canvas tem o tamanho do bloco).
const boxOnScreen = async (page) => {
  const overlay = page.getByTestId('annotation-box').first();

  await overlay.waitFor();

  const box = await overlay.boundingBox();
  const target = await pageImage(page).boundingBox();

  return {
    x: ((box.x - target.x) / target.width) * 100,
    y: ((box.y - target.y) / target.height) * 100,
    width: (box.width / target.width) * 100,
    height: (box.height / target.height) * 100,
    centerX: ((box.x + box.width / 2 - target.x) / target.width) * 100,
    centerY: ((box.y + box.height / 2 - target.y) / target.height) * 100,
  };
};

const near = (a, b) => Math.abs(a - b) <= TOLERANCE;
const fmt = (rect) =>
  JSON.stringify(Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, +value.toFixed(1)])));

const openSendDialog = async (page) => {
  await page.goto(`${baseUrl}/t/${teamUrl}/documents/${draftId}/edit`, { waitUntil: 'networkidle' });
  await page
    .getByRole('button', { name: /enviar documento/i })
    .filter({ visible: true })
    .first()
    .click();

  const dialog = page.getByRole('dialog');

  await dialog.getByTestId('invoice-account-panel').waitFor();
  await dialog.getByText('Buscando sugestão…').first().waitFor({ state: 'detached', timeout: 40_000 });

  return dialog;
};

const waitSubmit = async (page, enabled, timeout = 20_000) => {
  await page.waitForFunction(
    (wanted) => {
      const button = document.querySelector('[role="dialog"] button[type="submit"]');

      return Boolean(button) && !button.disabled === wanted;
    },
    enabled,
    { timeout },
  );
};

const pdfLines = async (dialog) =>
  (await dialog.getByTestId('invoice-pdf-annotation-line').allInnerTexts()).map((text) =>
    text.replace(/\s+/g, ' ').trim(),
  );

if (payload.case === 'drag') {
  await section('arrastar o bloco para a nota, recarregar e ver no mesmo lugar', async () => {
    const { context, page } = await openAs(ownerCookie, DESKTOP);

    await openFieldsStep(page);

    const button = page.getByTestId('annotation-box-palette-button');

    report((await normalized(button)) === 'Conta e centro de custo', 'a paleta tem o botão "Conta e centro de custo"');
    report(
      (await button.evaluate((element) => getComputedStyle(element).borderStyle)) === 'dashed',
      'o botão do bloco é tracejado (não parece um campo de assinatura)',
    );

    await dragBoxTo(page, dropAt);

    const placed = await boxOnScreen(page);

    report(
      near(placed.centerX, dropAt.x) && near(placed.centerY, dropAt.y),
      `o bloco ficou onde foi solto (${fmt(placed)}; solto em ${JSON.stringify(dropAt)})`,
    );
    report(
      (await normalized(page.getByTestId('annotation-box-label'))) === 'Conta e centro de custo',
      'o bloco tem a etiqueta "Conta e centro de custo"',
    );
    await shot(page, 'conta-cc-editor-bloco');

    await page.reload({ waitUntil: 'networkidle' });
    await pageImage(page).waitFor();

    const reloaded = await boxOnScreen(page);

    report(
      near(reloaded.x, placed.x) &&
        near(reloaded.y, placed.y) &&
        near(reloaded.width, placed.width) &&
        near(reloaded.height, placed.height),
      `depois de recarregar, o bloco está no mesmo lugar (${fmt(reloaded)} x ${fmt(placed)})`,
    );

    const dialog = await openSendDialog(page);
    const lines = await pdfLines(dialog);

    report(
      lines.length === 1 && lines[0] === LINE_WITH_BOX,
      `o diálogo diz "${LINE_WITH_BOX}" (veio ${JSON.stringify(lines)})`,
    );
    await shot(page, 'conta-cc-envio-com-bloco');
    await context.close();
  });
}

if (payload.case === 'remove') {
  await section('sem bloco: a linha diz sem conta e centro', async () => {
    const { context, page } = await openAs(ownerCookie, DESKTOP);

    await openFieldsStep(page);

    // O bloco gravado pela rota aparece; um clique nele mostra o botão de tirar.
    const overlay = page.getByTestId('annotation-box').first();

    await overlay.waitFor();
    await overlay.scrollIntoViewIfNeeded();

    const box = await overlay.boundingBox();
    const removed = page.waitForResponse(isBoxRoute('delete'));

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByTestId('annotation-box-remove').click();

    const res = await removed;

    report(res.ok(), `o bloco foi tirado (HTTP ${res.status()})`);
    await overlay.waitFor({ state: 'detached' });
    report(true, 'o bloco sumiu da página');

    const dialog = await openSendDialog(page);
    const lines = await pdfLines(dialog);

    report(
      lines.length === 1 && lines[0] === LINE_WITHOUT_BOX,
      `o diálogo diz "${LINE_WITHOUT_BOX}" (veio ${JSON.stringify(lines)})`,
    );
    await shot(page, 'conta-cc-envio-sem-bloco');
    await context.close();
  });
}

if (payload.case === 'contract') {
  await section('bloco no contrato: aviso em âmbar e Enviar continua liberado', async () => {
    const { context, page } = await openAs(ownerCookie, DESKTOP);
    const dialog = await openSendDialog(page);
    const warnings = dialog.getByTestId('invoice-annotation-box-warnings');
    const expected = contractWarning('contrato.pdf');

    report((await normalized(warnings)) === expected, `o diálogo avisa "${expected}"`);
    report(
      (await warnings.evaluate((element) => getComputedStyle(element).backgroundColor)) !== 'rgba(0, 0, 0, 0)',
      'o aviso tem o fundo âmbar (warning-bg)',
    );
    report(
      JSON.stringify(await pdfLines(dialog)) === JSON.stringify([LINE_WITHOUT_BOX]),
      'a nota diz que sai sem conta e centro (o bloco está no contrato)',
    );
    await waitSubmit(page, true);
    report(true, 'Enviar continua liberado com o aviso');
    await shot(page, 'conta-cc-envio-aviso-contrato');
    await context.close();
  });

  await section('celular de 390 px: a linha e o aviso cabem', async () => {
    const { context, page } = await openAs(ownerCookie, PHONE);
    const dialog = await openSendDialog(page);

    await dialog.getByTestId('invoice-annotation-box-warnings').waitFor();
    report(
      await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      'o diálogo não rola para o lado',
    );

    for (const testId of ['invoice-pdf-annotation-line', 'invoice-annotation-box-warnings']) {
      const box = await dialog.getByTestId(testId).first().boundingBox();

      report(Boolean(box) && box.x >= -1 && box.x + box.width <= PHONE.width + 1, `${testId} cabe na tela`);
    }

    await dialog.getByTestId('invoice-annotation-box-warnings').scrollIntoViewIfNeeded();
    await shot(page, 'conta-cc-envio-390');
    await context.close();
  });
}

if (payload.case === 'not-a-field') {
  await section('o bloco não conta como campo de assinatura', async () => {
    const { context, page } = await openAs(ownerCookie, DESKTOP);

    await openFieldsStep(page);
    await dragBoxTo(page, dropAt);
    await boxOnScreen(page);

    const dialog = await openSendDialog(page);

    report(
      JSON.stringify(await pdfLines(dialog)) === JSON.stringify([LINE_WITH_BOX]),
      'o diálogo diz que a nota sai com conta e centro na página 1',
    );
    await waitSubmit(page, true);
    report(true, 'com uma assinatura em cada arquivo e o bloco numa nota, Enviar libera');
    await context.close();
  });
}

await finish();
