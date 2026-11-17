// REVALLE: chamado por `recipient-name-ui.test.mjs` (ver `shared.mjs`). Confere, no navegador, o passo "Documento e
// Destinatários" do editor sem o campo Nome: só o e-mail, o papel e as opções; "Conta: {nome}" em cinza ao digitar o
// e-mail de uma conta e nada para um e-mail sem conta; o salvamento automático grava o e-mail digitado.
//
// Entrada: a URL, o time, a sessão do dono, o rascunho (`draftId`, com um signatário), o e-mail e o nome de uma conta
// (`accountEmail`, `accountName`) e um e-mail sem conta (`noAccountEmail`). Quem chama confere o banco e o envio depois.
import { finish, openAs, payload, report, section, shot } from './shared.mjs';

const { baseUrl, teamUrl, ownerCookie, draftId, accountEmail, accountName, noAccountEmail } = payload;

const PHONE = { width: 390, height: 844 };

const editUrl = `${baseUrl}/t/${teamUrl}/documents/${draftId}/edit`;
const NAME_INPUTS = 'input[aria-label="Nome"], input[aria-label="Name"], input[name$=".name"]';

const isRecipientsSave = (res) => res.url().includes('envelope.recipient.set') && res.request().method() === 'POST';

const openEditor = async (page) => {
  await page.goto(editUrl, { waitUntil: 'networkidle' });
  await page.getByTestId('signer-email-input').first().waitFor();
};

// Troca o e-mail do primeiro signatário e espera o salvamento automático (1 s depois da última tecla).
const typeEmail = async (page, email) => {
  const input = page.getByTestId('signer-email-input').first();
  const saved = page.waitForResponse(isRecipientsSave, { timeout: 20_000 });

  await input.fill('');
  await input.pressSequentially(email, { delay: 10 });
  // Fecha a lista de sugestões sem escolher nenhuma.
  await page.keyboard.press('Escape');

  const res = await saved;

  report(res.ok(), `salvou o e-mail ${email.split('@')[1]} (HTTP ${res.status()})`);
};

await section('sem o campo Nome; "Conta: {nome}" para o e-mail de uma conta', async () => {
  const { context, page } = await openAs(ownerCookie);

  await openEditor(page);
  report((await page.locator(NAME_INPUTS).count()) === 0, 'sem o campo Nome');
  report(
    (await page.getByPlaceholder(/^(Destinatário|Recipient) \d+$/).count()) === 0,
    'sem o "Destinatário 1" do campo Nome',
  );

  await typeEmail(page, noAccountEmail);
  await page.waitForTimeout(1500);
  report((await page.getByTestId('revalle-account-hint').count()) === 0, 'e-mail sem conta: sem "Conta:"');

  await typeEmail(page, accountEmail);

  const hint = page.getByTestId('revalle-account-hint').first();

  await hint.waitFor({ timeout: 15_000 });
  report((await hint.innerText()).trim() === `Conta: ${accountName}`, `"Conta: ${accountName}" ao lado do e-mail`);
  report(
    await hint.evaluate((el) => el.className.includes('text-muted-foreground')),
    '"Conta:" em cinza (text-muted-foreground)',
  );
  await shot(page, 'destinatario-so-email-conta');
  await context.close();
});

await section('celular de 390 px: o e-mail ocupa a linha, sem rolagem lateral', async () => {
  const { context, page } = await openAs(ownerCookie, PHONE);

  await openEditor(page);
  report((await page.locator(NAME_INPUTS).count()) === 0, 'celular: sem o campo Nome');
  report(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    'celular: sem rolagem lateral',
  );
  await shot(page, 'destinatario-so-email-celular');
  await context.close();
});

await finish();
