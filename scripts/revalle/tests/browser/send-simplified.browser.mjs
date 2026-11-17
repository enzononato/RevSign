// REVALLE: chamado por `send-simplified.test.mjs` (ver `shared.mjs`). Confere, no navegador, o envio simplificado: o
// diálogo de envio sem as abas "E-mail"/"Nenhum" e sem "E-mail para resposta", "Assunto" e "Mensagem", com as duas opções
// ("Enviar por e-mail (recomendado)", a padrão, e "Só gerar os links"); a aba Notificações das configurações do documento
// sem os três campos; "Só gerar os links" envia e abre a tela dos links; "Enviar por e-mail" envia.
//
// Entrada: a URL, o time, a sessão do dono e dois rascunhos salvos com e-mail (`linksId`, `emailId`), cada um com dois
// signatários. Quem chama confere os e-mails (Mailpit) e o banco depois.
import { finish, openAs, payload, report, section, shot } from './shared.mjs';

const { baseUrl, teamUrl, ownerCookie, linksId, emailId } = payload;

const PHONE = { width: 390, height: 844 };
const EMAIL_OPTION = 'Enviar por e-mail (recomendado)';
const LINKS_OPTION = 'Só gerar os links';
const OLD_FIELDS = 'input[name="meta.emailReplyTo"], input[name="meta.subject"], textarea[name="meta.message"]';

const editUrl = (id) => `${baseUrl}/t/${teamUrl}/documents/${id}/edit`;

const openSendDialog = async (page, id) => {
  await page.goto(editUrl(id), { waitUntil: 'networkidle' });
  await page
    .getByRole('button', { name: /enviar documento/i })
    .filter({ visible: true })
    .first()
    .click();

  const dialog = page.getByRole('dialog');

  await dialog.getByTestId('distribution-method').waitFor();

  // Documento comum sem resposta da IA: o painel da nota fiscal pode perguntar antes de liberar o Enviar. Espera um dos
  // dois: a pergunta (responde "Não") ou o Enviar liberado.
  const question = dialog.getByTestId('invoice-question');
  const submitButton = dialog.locator('button[type="submit"]');
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (await question.isVisible().catch(() => false)) {
      await question.getByRole('button', { name: 'Não', exact: true }).click();
      await question.waitFor({ state: 'detached' });
      break;
    }

    if (await submitButton.isEnabled().catch(() => false)) {
      break;
    }

    await page.waitForTimeout(250);
  }

  return dialog;
};

const submit = async (page, dialog) => {
  const button = dialog.locator('button[type="submit"]');

  await page.waitForFunction(() => !document.querySelector('[role="dialog"] button[type="submit"]')?.disabled, null, {
    timeout: 20_000,
  });

  return button;
};

const checkDialog = async (dialog, label) => {
  report((await dialog.getByRole('tab').count()) === 0, `${label}: sem as abas "E-mail"/"Nenhum"`);
  report((await dialog.locator(OLD_FIELDS).count()) === 0, `${label}: sem os campos de resposta, assunto e mensagem`);

  const radios = dialog.getByRole('radio');

  report((await radios.count()) === 2, `${label}: duas opções`);
  report(
    (await dialog.getByRole('radio', { name: EMAIL_OPTION, exact: true }).count()) === 1,
    `${label}: opção "${EMAIL_OPTION}"`,
  );
  report(
    (await dialog.getByRole('radio', { name: LINKS_OPTION, exact: true }).count()) === 1,
    `${label}: opção "${LINKS_OPTION}"`,
  );
  report(
    (await dialog.getByRole('radio', { name: EMAIL_OPTION, exact: true }).getAttribute('aria-checked')) === 'true',
    `${label}: "${EMAIL_OPTION}" vem marcada (rascunho salvo com e-mail)`,
  );
};

await section('configurações do documento: aba Notificações sem os três campos', async () => {
  const { context, page } = await openAs(ownerCookie);

  await page.goto(editUrl(emailId), { waitUntil: 'networkidle' });
  await page.locator('button[title="Configurações"]').filter({ visible: true }).first().click();

  const dialog = page.getByRole('dialog');

  await dialog.getByRole('button', { name: 'Notificações' }).click();
  // A aba carregou: as caixas dos e-mails continuam lá.
  await dialog.getByRole('checkbox').first().waitFor();

  report((await dialog.locator(OLD_FIELDS).count()) === 0, 'Notificações: sem resposta, assunto e mensagem');
  await shot(page, 'envio-simplificado-configuracoes');
  await context.close();
});

await section('diálogo no celular de 390 px', async () => {
  const { context, page } = await openAs(ownerCookie, PHONE);
  const dialog = await openSendDialog(page, linksId);

  await checkDialog(dialog, 'celular');
  report(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    'celular: sem rolagem lateral',
  );
  await shot(page, 'envio-simplificado-celular');
  await context.close();
});

await section('"Só gerar os links": envia e abre a tela dos links', async () => {
  const { context, page } = await openAs(ownerCookie);
  const dialog = await openSendDialog(page, linksId);

  await checkDialog(dialog, 'computador');
  await dialog.getByText(LINKS_OPTION, { exact: true }).click();
  report(
    (await dialog.getByRole('radio', { name: LINKS_OPTION, exact: true }).getAttribute('aria-checked')) === 'true',
    'clicar no texto escolhe "Só gerar os links"',
  );

  const button = await submit(page, dialog);

  report((await button.innerText()).trim() === 'Gerar Links', 'o botão vira "Gerar Links"');
  await shot(page, 'envio-simplificado-links');
  await button.click();

  await page.waitForURL(new RegExp(`/documents/${linksId}(\\?|$)`), { timeout: 30_000 });
  await page.getByRole('dialog').getByText('Copiar Links de Assinatura').waitFor({ timeout: 20_000 });
  report(true, 'a tela dos links abre depois do envio');
  report(
    (await page
      .getByRole('dialog')
      .getByText(/@gmail\.com/)
      .count()) === 2,
    'a tela dos links lista os dois signatários',
  );
  await shot(page, 'envio-simplificado-links-abertos');
  await context.close();
});

await section('"Enviar por e-mail": envia', async () => {
  const { context, page } = await openAs(ownerCookie);
  const dialog = await openSendDialog(page, emailId);
  const button = await submit(page, dialog);

  report((await button.innerText()).trim() === 'Enviar', 'o botão é "Enviar"');
  await button.click();
  await page.waitForURL(new RegExp(`/documents/${emailId}(\\?|$)`), { timeout: 30_000 });
  report(true, 'enviado por e-mail');
  await context.close();
});

await finish();
