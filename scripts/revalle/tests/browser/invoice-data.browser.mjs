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

  const row = page.getByRole('row').filter({ hasText: sentTitle });
  const dataLine = row.getByTestId('invoice-row-data');

  await dataLine.waitFor();

  const text = (await dataLine.innerText()).trim();
  const title = await dataLine.getAttribute('title');

  report(text === line, `a lista mostra "${line}" abaixo do título (veio "${text}")`);
  report(!text.includes('Lido pela IA'), 'a lista não repete o prefixo');
  report(
    title === 'Lidos pela IA, confira no PDF',
    'a linha da lista avisa que foi lida pela IA (ajuda ao passar o mouse)',
  );
  await context.close();
});

await finish();
