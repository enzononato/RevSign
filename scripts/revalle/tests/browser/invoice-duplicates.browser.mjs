// REVALLE (Fase 8): chamado por `invoice-duplicates.test.mjs` (ver `shared.mjs`). Confere, no navegador, o alerta de nota
// duplicada: o diálogo de envio (o aviso, o botão Enviar travado até a confirmação, no computador e no celular, e o aviso
// que chega com o diálogo aberto quando a chave só vem com a resposta da IA), o cartão do dono depois do envio, a marca na
// lista e o alerta da página da NF.
//
// Entrada: a URL, o time, as sessões do dono (colaborador comum) e do Financeiro, um rascunho de NF que repete outra NF
// (`draftId`, e a outra nota: `otherTitle` e `otherId`), uma NF escaneada ainda sem resposta (`lateId`, a IA devolve a chave
// devagar) e uma NF já enviada do dono que repete outra (`sentId`, e a outra nota: `pairTitle` e `pairId`).
import { finish, openAs, payload, report, section, shot } from './shared.mjs';

const {
  baseUrl,
  teamUrl,
  ownerCookie,
  financeCookie,
  draftId,
  lateId,
  otherTitle,
  otherId,
  sentId,
  sentTitle,
  pairId,
  pairTitle,
  senderName,
} = payload;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const SENT_LINE = new RegExp(`^Enviada em \\d{2}/\\d{2}/\\d{4} \\d{2}:\\d{2} por ${senderName} · Pendente$`);

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// O elemento inteiro dentro da largura da tela (a rolagem lateral da página inteira também depende do resto da página).
const fitsViewport = async (page, locator) => {
  const box = await locator.boundingBox();
  const width = await page.evaluate(() => window.innerWidth);

  return Boolean(box) && box.x >= -1 && box.x + box.width <= width + 1;
};

const openSendDialog = async (page, id, readyTestId = 'invoice-account-panel') => {
  await page.goto(`${baseUrl}/t/${teamUrl}/documents/${id}/edit`, { waitUntil: 'networkidle' });
  await page
    .getByRole('button', { name: /enviar documento/i })
    .filter({ visible: true })
    .first()
    .click();

  const dialog = page.getByRole('dialog');

  await dialog.getByTestId(readyTestId).waitFor();

  return dialog;
};

const isSubmitEnabled = (dialog) => dialog.locator('button[type="submit"]').isEnabled();

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

for (const [name, viewport] of [
  ['computador', DESKTOP],
  ['celular de 390 px', PHONE],
]) {
  await section(`alerta no envio (${name})`, async () => {
    const { context, page } = await openAs(ownerCookie, viewport);
    const dialog = await openSendDialog(page, draftId);
    const alert = dialog.getByTestId('invoice-duplicate-alert');

    await alert.waitFor();

    const text = (await alert.innerText()).replace(/\s+/g, ' ');
    const lines = await alert.getByTestId('invoice-duplicate-line').allInnerTexts();

    report(
      text.includes('Esta nota parece já ter sido enviada'),
      'o alerta diz "Esta nota parece já ter sido enviada"',
    );
    report(
      lines.length === 1 && SENT_LINE.test(lines[0].trim()),
      `uma linha "Enviada em … por ${senderName} · Pendente" (veio ${JSON.stringify(lines)})`,
    );
    report(!(await dialog.innerText()).includes(otherTitle), 'o diálogo não mostra o título da outra nota');
    report((await alert.locator('a').count()) === 0, 'o alerta não tem link');
    report(!(await dialog.innerHTML()).includes(otherId), 'o diálogo não traz o id da outra nota');
    report(
      (await dialog.getByTestId('invoice-account-panel').innerText()).includes('Esta nota parece já ter sido enviada'),
      'o alerta fica dentro do bloco da nota',
    );

    const acknowledge = dialog.getByTestId('invoice-duplicate-ack');

    report(!(await isSubmitEnabled(dialog)), 'Enviar fica travado enquanto a confirmação não é marcada');
    await shot(page, `envio-${viewport.width}-aviso`);

    if (viewport.width === PHONE.width) {
      const box = await page.locator('label:has([data-testid="invoice-duplicate-ack"])').boundingBox();

      report((box?.height ?? 0) >= 44, `a linha da confirmação tem ao menos 44 px de altura (${box?.height})`);
      report(await fitsViewport(page, alert), 'o alerta cabe na largura do celular');
      report(
        await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        'o diálogo não rola para o lado no celular',
      );
    }

    await acknowledge.click();
    await waitSubmit(page, true, 5_000);
    report(true, 'Enviar libera depois de marcar "Sei disso e quero enviar mesmo assim"');
    report((await acknowledge.getAttribute('aria-checked')) === 'true', 'a caixa aparece marcada');
    await shot(page, `envio-${viewport.width}-confirmado`);

    await acknowledge.click();
    await waitSubmit(page, false, 5_000);
    report(true, 'desmarcar trava o Enviar de novo');
    await context.close();
  });
}

if (lateId) {
  await section('chave da IA chega com o diálogo aberto', async () => {
    const { context, page } = await openAs(ownerCookie, DESKTOP);
    // NF escaneada sem resposta: o bloco mostra a pergunta "É nota fiscal?" no lugar da conta.
    const dialog = await openSendDialog(page, lateId, 'invoice-question');

    await dialog.getByRole('button', { name: 'Sim', exact: true }).click();

    // A conta e o centro, como a tela grava (o envio só libera com os dois).
    for (const [procedure, json] of [
      ['revalle.invoice.setChoice', { envelopeId: lateId, choice: { code: '2.1.03' } }],
      ['revalle.invoice.setCostCenter', { envelopeId: lateId, code: '101' }],
    ]) {
      const res = await context.request.post(`${baseUrl}/api/trpc/${procedure}`, {
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        data: { json },
      });

      report(res.ok(), `${procedure} gravou (${res.status()})`);
    }

    await waitSubmit(page, true, 20_000);
    report(true, 'Enviar libera com a conta e o centro, enquanto a IA ainda lê a nota');
    report(
      (await dialog.getByTestId('invoice-duplicate-alert').count()) === 0,
      'ainda não há alerta: a chave da nota só chega com a resposta da IA',
    );
    await shot(page, 'envio-1280-ia-lendo');

    await dialog.getByTestId('invoice-duplicate-alert').waitFor({ timeout: 40_000 });
    report(true, 'o alerta aparece quando a chave da IA chega, com o diálogo aberto');
    await waitSubmit(page, false, 5_000);
    report(true, 'Enviar volta a ficar travado até a confirmação');
    await shot(page, 'envio-1280-ia-aviso');

    await dialog.getByTestId('invoice-duplicate-ack').click();
    await waitSubmit(page, true, 5_000);
    report(true, 'a confirmação libera o Enviar');
    await context.close();
  });
}

for (const [name, viewport] of [
  ['computador', DESKTOP],
  ['celular de 390 px', PHONE],
]) {
  await section(`cartão do dono depois do envio (${name})`, async () => {
    const { context, page } = await openAs(ownerCookie, viewport);

    await page.goto(`${baseUrl}/t/${teamUrl}/documents/${sentId}`, { waitUntil: 'networkidle' });

    const card = page.getByTestId('invoice-account-card');

    await card.waitFor();

    const alert = card.getByTestId('invoice-duplicate-alert');

    await alert.waitFor();

    const lines = await alert.getByTestId('invoice-duplicate-line').allInnerTexts();

    report(
      lines.length === 1 && SENT_LINE.test(lines[0].trim()),
      `o cartão traz "Enviada em … por ${senderName} · Pendente" (veio ${JSON.stringify(lines)})`,
    );
    report((await alert.getByTestId('invoice-duplicate-ack').count()) === 0, 'o cartão não pede confirmação');
    report((await alert.locator('a').count()) === 0, 'o cartão não tem link para a outra nota');
    report(!(await card.innerText()).includes(pairTitle), 'o cartão não mostra o título da outra nota');
    report(await fitsViewport(page, card), 'o cartão cabe na largura da tela');
    report(await fitsViewport(page, alert), 'o aviso cabe na largura da tela');
    await card.scrollIntoViewIfNeeded();
    await shot(page, `cartao-dono-${viewport.width}`);
    await context.close();
  });
}

for (const [name, viewport] of [
  ['computador', DESKTOP],
  ['celular de 390 px', PHONE],
]) {
  await section(`lista (${name})`, async () => {
    const finance = await openAs(financeCookie, viewport);

    await finance.page.goto(`${baseUrl}/notas-fiscais`, { waitUntil: 'networkidle' });

    const badgeOf = (page, title) =>
      page.getByRole('row').filter({ hasText: title }).first().getByTestId('invoice-row-duplicate');

    await badgeOf(finance.page, sentTitle).waitFor();

    const text = (await badgeOf(finance.page, sentTitle).innerText()).trim();

    report(text === 'Possível duplicada', `o Financeiro vê a marca "Possível duplicada" (veio "${text}")`);
    report((await badgeOf(finance.page, pairTitle).count()) === 1, 'a outra nota do par também tem a marca');
    report(await noSideScroll(finance.page), 'sem rolagem lateral na página');
    await badgeOf(finance.page, sentTitle).scrollIntoViewIfNeeded();
    await shot(finance.page, `lista-financeiro-${viewport.width}`);
    await finance.context.close();

    const owner = await openAs(ownerCookie, viewport);

    await owner.page.goto(`${baseUrl}/notas-fiscais`, { waitUntil: 'networkidle' });
    await owner.page.getByRole('row').filter({ hasText: sentTitle }).first().waitFor();
    report((await badgeOf(owner.page, sentTitle).count()) === 0, 'o colaborador comum não vê a marca na própria nota');
    await owner.context.close();
  });
}

for (const [name, viewport] of [
  ['computador', DESKTOP],
  ['celular de 390 px', PHONE],
]) {
  await section(`página da NF (${name})`, async () => {
    const { context, page } = await openAs(financeCookie, viewport);

    await page.goto(`${baseUrl}/notas-fiscais/${sentId}`, { waitUntil: 'networkidle' });

    const block = page.getByTestId('invoice-view-duplicates');

    await block.waitFor();

    const text = (await block.innerText()).replace(/\s+/g, ' ');
    const link = block.getByTestId('invoice-view-duplicate-link');

    report(
      text.includes('Esta nota parece já ter sido enviada'),
      'a página diz "Esta nota parece já ter sido enviada"',
    );
    report(text.includes(pairTitle), 'a página mostra o título da outra nota');
    report((await link.getAttribute('href')) === `/notas-fiscais/${pairId}`, 'o título leva à página da outra nota');
    report(text.includes(`por ${senderName} · Pendente`), 'a página mostra o remetente e a situação');
    report((await link.boundingBox())?.height >= 44, 'o link tem ao menos 44 px de altura');
    report(await noSideScroll(page), 'sem rolagem lateral');
    await shot(page, `pagina-nf-${viewport.width}`);
    await context.close();
  });
}

await finish();
