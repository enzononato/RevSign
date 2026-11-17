// REVALLE (Fase 9): chamado por `invoice-multi-ui.test.mjs` (ver `shared.mjs`). Confere, no navegador, o diálogo de envio
// com várias notas: um bloco por arquivo, o aviso do boleto, o Enviar que só libera com conta e centro em todas as notas e
// com o tipo de todo arquivo sem texto respondido, e o celular de 390 px sem rolagem lateral.
//
// Entrada: a URL, o time, a sessão do dono, o rascunho (`draftId`), os arquivos dele (`items`: título → envelopeItemId),
// a mensagem esperada do boleto (`boletoWarning`) e o caso (`case`: 'blocks', 'scanned' ou 'phone').
import { finish, openAs, payload, report, section, shot } from './shared.mjs';

const { baseUrl, teamUrl, ownerCookie, draftId, items, boletoWarning } = payload;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

const openSendDialog = async (page) => {
  await page.goto(`${baseUrl}/t/${teamUrl}/documents/${draftId}/edit`, { waitUntil: 'networkidle' });
  await page
    .getByRole('button', { name: /enviar documento/i })
    .filter({ visible: true })
    .first()
    .click();

  const dialog = page.getByRole('dialog');

  await dialog.getByTestId('invoice-account-panel').waitFor();
  await dialog.getByTestId('invoice-file-header').first().waitFor();
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

// O Enviar continua desabilitado (espera um pouco: a gravação da última escolha pode ainda estar chegando).
const staysDisabled = async (page) => {
  try {
    await waitSubmit(page, true, 3_000);

    return false;
  } catch {
    return true;
  }
};

const blockOf = (dialog, title) => dialog.locator(`[data-envelope-item-id="${items[title]}"]`);

const chooseAccount = async (block) => {
  await block.locator('ul button').first().click();
  await block.getByTestId('invoice-file-choice').waitFor();
};

const chooseCenter = async (page, block) => {
  await block.getByTestId('invoice-cost-center').click();
  await page.getByRole('option').first().click();
  await block.getByText('Escolha o centro de custo.').waitFor({ state: 'detached' });
};

const normalized = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();

if (payload.case === 'blocks') {
  await section('diálogo com uma nota por bloco e o aviso do boleto', async () => {
    const { context, page } = await openAs(ownerCookie, DESKTOP);
    const dialog = await openSendDialog(page);
    const headers = (await dialog.getByTestId('invoice-file-header').allInnerTexts()).map((text) =>
      text.replace(/\s+/g, ' ').trim(),
    );

    for (const expected of ['Nota 1 de 3 · nf-a.pdf', 'Nota 2 de 3 · nf-b.pdf', 'Nota 3 de 3 · nf-c.pdf']) {
      report(headers.includes(expected), `o bloco "${expected}" aparece (cabeçalhos: ${JSON.stringify(headers)})`);
    }

    report(headers.includes('Boleto · boleto.pdf'), 'o bloco "Boleto · boleto.pdf" aparece');
    report(headers.includes('contrato.pdf · documento comum'), 'o contrato aparece como "documento comum"');
    report(
      JSON.stringify(headers) ===
        JSON.stringify([
          'contrato.pdf · documento comum',
          'Nota 1 de 3 · nf-a.pdf',
          'Nota 2 de 3 · nf-b.pdf',
          'Nota 3 de 3 · nf-c.pdf',
          'Boleto · boleto.pdf',
        ]),
      'os blocos seguem a ordem dos arquivos',
    );

    const boleto = blockOf(dialog, 'boleto.pdf');
    const warnings = await boleto.getByTestId('invoice-boleto-warnings').innerText();
    const boletoLine = await normalized(boleto.getByTestId('invoice-boleto-line'));

    report(warnings.includes(boletoWarning), `o boleto avisa "${boletoWarning}" (veio "${warnings.trim()}")`);
    report(
      /^Lido: .*R\$ 1\.499,00 · vence \d{2}\/\d{2}\/\d{4}$/.test(boletoLine),
      `a linha do boleto traz o valor e o vencimento (veio "${boletoLine}")`,
    );
    report(
      (await blockOf(dialog, 'nf-b.pdf').getByTestId('invoice-data-line').innerText()).includes('R$ 200,00'),
      'cada nota mostra os próprios dados lidos pela IA (nf-b: R$ 200,00)',
    );
    report(await staysDisabled(page), 'Enviar desabilitado sem conta e centro nas notas');
    await shot(page, 'f9-envio-1280-inicio');

    // A conta das três e o centro da 1ª e da 3ª: falta só o centro da 2ª.
    for (const title of ['nf-a.pdf', 'nf-b.pdf', 'nf-c.pdf']) {
      await chooseAccount(blockOf(dialog, title));
    }

    report(await staysDisabled(page), 'só com as contas, Enviar continua desabilitado');

    await chooseCenter(page, blockOf(dialog, 'nf-a.pdf'));
    await chooseCenter(page, blockOf(dialog, 'nf-c.pdf'));
    report(await staysDisabled(page), 'sem o centro da 2ª nota, Enviar continua desabilitado');
    report(
      (await blockOf(dialog, 'nf-b.pdf').getByText('Escolha o centro de custo.').count()) === 1,
      'o bloco da 2ª nota diz o que falta',
    );

    await chooseCenter(page, blockOf(dialog, 'nf-b.pdf'));
    await waitSubmit(page, true);
    report(true, 'com conta e centro nas três notas, Enviar libera (o aviso do boleto não trava)');
    await shot(page, 'f9-envio-1280-pronto');
    await context.close();
  });
}

if (payload.case === 'scanned') {
  await section('escaneado pede o tipo antes de enviar', async () => {
    const { context, page } = await openAs(ownerCookie, DESKTOP);
    const dialog = await openSendDialog(page);
    const scanned = blockOf(dialog, 'escaneado.pdf');

    await scanned.waitFor();
    report(
      (await scanned.getAttribute('data-testid')) === 'invoice-unknown-file',
      'o arquivo sem texto tem o bloco da pergunta',
    );
    report((await normalized(scanned)).includes('Este arquivo é:'), 'o arquivo sem texto pergunta "Este arquivo é:"');

    for (const option of ['Nota fiscal', 'Boleto', 'Outro documento']) {
      report(
        (await scanned.getByRole('button', { name: option, exact: true }).count()) === 1,
        `a pergunta tem a opção "${option}"`,
      );
    }

    report(await staysDisabled(page), 'Enviar desabilitado com o tipo sem resposta (a nota já tem conta e centro)');

    await scanned.getByRole('button', { name: 'Outro documento', exact: true }).click();
    await dialog.getByText('escaneado.pdf · documento comum').waitFor();
    await waitSubmit(page, true);
    report(true, 'depois de "Outro documento", Enviar libera');

    // O que a pessoa vê: os blocos continuam (a nota com o cabeçalho dela) e o escaneado vira a linha de documento comum,
    // com o seletor à mão para desfazer.
    report(
      (await scanned.getAttribute('data-testid')) === 'invoice-other-file',
      'o escaneado vira a linha "documento comum"',
    );
    report(
      (await scanned.getByRole('button', { name: 'Outro documento', exact: true }).getAttribute('aria-pressed')) ===
        'true',
      'o seletor marca "Outro documento"',
    );
    report(
      (await scanned.getByRole('button', { name: 'Nota fiscal', exact: true }).isEnabled()) === true,
      'o seletor continua com "Nota fiscal" para desfazer',
    );
    report(
      (await normalized(blockOf(dialog, 'nf-s.pdf').getByTestId('invoice-file-header'))) === 'Nota 1 de 1 · nf-s.pdf',
      'a nota continua no bloco dela ("Nota 1 de 1 · nf-s.pdf")',
    );
    await context.close();
  });
}

if (payload.case === 'phone') {
  await section('celular de 390 px', async () => {
    const { context, page } = await openAs(ownerCookie, PHONE);
    const dialog = await openSendDialog(page);

    report(
      await page.evaluate(() => document.documentElement.scrollWidth <= 390),
      'a página não rola para o lado com o diálogo aberto',
    );
    report(
      await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      'o diálogo não rola para o lado',
    );

    // Todos os arquivos, inclusive a nota com o nome de 44 dígitos (sem espaço para quebrar a linha).
    for (const title of Object.keys(items)) {
      const box = await blockOf(dialog, title).boundingBox();

      report(Boolean(box) && box.x >= -1 && box.x + box.width <= PHONE.width + 1, `o bloco de ${title} cabe na tela`);
    }

    const kindButtons = await dialog.getByTestId('invoice-file-kind').getByRole('button').all();
    const heights = await Promise.all(kindButtons.map(async (button) => (await button.boundingBox())?.height ?? 0));

    report(
      heights.length > 0 && heights.every((height) => height >= 44),
      `os botões do tipo têm ao menos 44 px (${JSON.stringify(heights)})`,
    );

    await shot(page, 'f9-envio-390-topo');
    await blockOf(dialog, 'nf-b.pdf').scrollIntoViewIfNeeded();
    await shot(page, 'f9-envio-390-nota-2');
    await blockOf(dialog, 'boleto.pdf').scrollIntoViewIfNeeded();
    await shot(page, 'f9-envio-390-boleto');
    await context.close();
  });
}

await finish();
