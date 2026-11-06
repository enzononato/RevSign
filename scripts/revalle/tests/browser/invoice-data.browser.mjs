// REVALLE (Fase 8): chamado por `invoice-data.test.mjs` (ver `shared.mjs`). Confere, no navegador, as duas telas que só
// existem depois do carregamento: o bloco da NF no diálogo de envio ("Lido pela IA: …") e a linha abaixo do título na
// lista "Notas fiscais".
//
// Entrada: a URL, o time e a sessão do dono, um rascunho de NF com a sugestão pronta, o título de uma NF já enviada e a
// linha esperada (`Fornecedor · Nº número · R$ valor`).
import { finish, openAs, payload, report, section } from './shared.mjs';

const { baseUrl, teamUrl, ownerCookie, draftId, sentTitle, line } = payload;

await section('bloco de envio', async () => {
  const { context, page } = await openAs(ownerCookie);

  await page.goto(`${baseUrl}/t/${teamUrl}/documents/${draftId}/edit`, { waitUntil: 'networkidle' });
  await page
    .getByRole('button', { name: /enviar documento/i })
    .filter({ visible: true })
    .first()
    .click();

  const panel = page.getByRole('dialog').getByTestId('invoice-account-panel');

  await panel.waitFor();
  await panel.getByText('Buscando sugestão…').waitFor({ state: 'detached', timeout: 40_000 });

  const dataLine = panel.getByTestId('invoice-data-line');

  await dataLine.waitFor();

  const text = (await dataLine.innerText()).trim();

  report(text === `Lido pela IA: ${line}`, `o bloco diz "Lido pela IA: ${line}" (veio "${text}")`);

  const suggestionBox = panel.getByText(/Sugestão da IA:/);
  const suggestionBottom = (await suggestionBox.boundingBox())?.y ?? 0;
  const dataTop = (await dataLine.boundingBox())?.y ?? 0;

  report(dataTop > suggestionBottom, 'a linha dos dados vem abaixo da sugestão');
  await context.close();
});

await section('lista', async () => {
  const { context, page } = await openAs(ownerCookie);

  await page.goto(`${baseUrl}/notas-fiscais`, { waitUntil: 'networkidle' });

  // Redesign v3: cada NF é um cartão. O número e o fornecedor lidos pela IA viram o título ("NF 12345 · Fornecedor"),
  // o valor fica no fim da linha das etiquetas e o título do documento vai para a linha de baixo.
  const row = page.getByTestId('invoice-row').filter({ hasText: sentTitle });
  const heading = row.getByRole('heading').first();
  const amount = row.locator('[title="Lidos pela IA, confira no PDF"]').filter({ hasText: 'R$' });

  await heading.waitFor();

  const headingText = (await heading.innerText()).trim();
  const headingTitle = await heading.locator('[title]').first().getAttribute('title');
  const amountText = (await amount.innerText()).trim().replace(/\s/g, ' ');

  report(
    headingText === 'NF 12345 · Fornecedor Falso LTDA',
    `o título do cartão traz número e fornecedor (veio "${headingText}")`,
  );
  report(amountText === 'R$ 1.234,56', `o cartão mostra o valor (veio "${amountText}")`);
  report(!headingText.includes('Lido pela IA'), 'a lista não repete o prefixo');
  report(
    headingTitle === 'Lidos pela IA, confira no PDF',
    'o título do cartão avisa que foi lido pela IA (ajuda ao passar o mouse)',
  );

  // No toque não há `title`: a legenda visível, acima da tabela, diz de onde vêm os dados da linha curta.
  const legend = page.getByTestId('invoice-data-legend');
  const legendText = (await legend.innerText()).trim();
  const legendBox = await legend.boundingBox();
  const legendBottom = legendBox ? legendBox.y + legendBox.height : Number.POSITIVE_INFINITY;
  const tableTop = (await page.getByTestId('invoice-row').first().boundingBox())?.y ?? 0;

  report(
    legendText === 'Fornecedor, número e valor: lidos pela IA, confira no PDF.',
    `a lista tem a legenda "Fornecedor, número e valor: lidos pela IA, confira no PDF." (veio "${legendText}")`,
  );
  report(legendBottom < tableTop, 'a legenda fica acima da tabela');
  report((await page.getByTestId('invoice-data-legend').count()) === 1, 'a legenda aparece uma vez, não uma por nota');
  await context.close();
});

await section('lista sem nenhuma nota com dados: sem a legenda', async () => {
  const { context, page } = await openAs(ownerCookie, { width: 390, height: 844 });

  await page.goto(`${baseUrl}/notas-fiscais?de=2001-01-01&ate=2001-01-02`, { waitUntil: 'networkidle' });
  await page.getByText('Nenhuma nota fiscal com esses filtros.').waitFor();
  report((await page.getByTestId('invoice-data-legend').count()) === 0, 'a legenda não aparece com a lista vazia');
  await context.close();
});

await finish();
