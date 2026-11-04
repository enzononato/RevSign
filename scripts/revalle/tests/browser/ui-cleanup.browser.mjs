// REVALLE (Fase 7, Task 9): roda DENTRO da imagem do Playwright, chamado por `ui-cleanup.test.mjs` (o WSL não abre o
// Chromium; ver `scripts/revalle/mobile-check.mjs`). Os menus, a busca, a lista de configurações, o editor e o seletor de
// papel são desenhados no navegador, então só um navegador de verdade confere que a IA, os Modelos, o papel Assistente,
// o Idioma e o Suporte saíram da tela (e que o resto continua lá).
//
// Entrada: a variável CLEANUP_PAYLOAD (JSON com a URL, o time, a organização, o cookie de uma conta comum e um rascunho).
// Escreve uma linha por conferência (`ok ...` ou `FALHOU ...`) e sai com código 1 se alguma falhar. Com SHOT_DIR, guarda
// um print por tela (a pasta precisa estar montada no container).
import { chromium } from 'playwright';

const { phase = 'main', baseUrl, teamUrl, orgUrl, cookie, draftId } = JSON.parse(process.env.CLEANUP_PAYLOAD ?? '{}');
const shotDir = process.env.SHOT_DIR;
const failures = [];

const report = (passed, message) => {
  console.log(`${passed ? 'ok' : 'FALHOU'} ${message}`);

  if (!passed) {
    failures.push(message);
  }
};

// A tela sai em português, mas o teste vale para os dois idiomas: o que não pode aparecer, nem em inglês.
const TEMPLATES = /\b(Templates?|Modelos?)\b/i;
const LANGUAGE = /^(Language|Idioma)$/i;
const SUPPORT = /^(Support|Suporte)$/i;
const AI_BUTTON =
  /Detect with AI|Detectar com IA|Detect recipients|Detectar destinat|Enable AI|Ativar a IA|Ativar detec/i;
const ASSISTANT = /Can prepare|Pode preparar|Assistant|Assistente/i;
const SAVE_AS_TEMPLATE = /Save as Template|Salvar como modelo/i;

const browser = await chromium.launch();

const openAs = async (viewport = { width: 1280, height: 900 }) => {
  const context = await browser.newContext({ viewport, locale: 'pt-BR' });

  await context.addCookies(
    cookie.split('; ').map((pair) => {
      const index = pair.indexOf('=');

      return { name: pair.slice(0, index), value: pair.slice(index + 1), url: baseUrl };
    }),
  );

  const page = await context.newPage();

  page.setDefaultTimeout(30_000);

  return { context, page };
};

const shot = async (page, name) => {
  if (shotDir) {
    await page.screenshot({ path: `${shotDir}/${name}.png` });
  }
};

const visit = async (page, route) => {
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
};

// Cada bloco roda isolado: um erro (elemento que não apareceu) vira uma falha com o motivo e os outros blocos seguem.
const section = async (name, fn) => {
  try {
    await fn();
  } catch (error) {
    report(false, `${name}: ${String(error.message).split('\n')[0]}`);
  }
};

const texts = (locator) => locator.allInnerTexts().then((list) => list.map((text) => text.trim()).filter(Boolean));

const finish = async () => {
  await browser.close();

  if (failures.length > 0) {
    console.log(`\n${failures.length} conferência(s) falharam`);
  }

  process.exit(failures.length > 0 ? 1 : 0);
};

// ---- Fase do ADMIN (a conta é promovida por quem chama): vê Tokens de API e Webhooks, e só isso a mais ---------------
if (phase === 'admin') {
  await section('configurações do ADMIN', async () => {
    const { context, page } = await openAs();

    await visit(page, `/t/${teamUrl}/settings/general`);

    const adminNav = await page
      .locator('[data-testid^="unified-settings-nav-"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));

    for (const keep of [
      'team-general',
      'team-reminders',
      'team-members',
      'team-groups',
      'team-tokens',
      'team-webhooks',
    ]) {
      report(adminNav.includes(`unified-settings-nav-${keep}`), `o ADMIN vê ${keep} nas configurações`);
    }

    for (const hidden of ['preferences', 'branding', 'email', 'document', 'certificates', 'public-profile']) {
      report(
        !adminNav.some((id) => id?.endsWith(`-${hidden}`)),
        `o ADMIN também não vê ${hidden} (${adminNav.filter((id) => id?.endsWith(`-${hidden}`)).join(', ') || 'ausente'})`,
      );
    }

    await shot(page, '10-configuracoes-admin');

    await visit(page, `/t/${teamUrl}/settings/tokens`);
    report(page.url() === `${baseUrl}/t/${teamUrl}/settings/tokens`, `o ADMIN abre /settings/tokens (${page.url()})`);
    report(
      /API Tokens|Tokens de API/i.test(await page.locator('body').innerText()),
      'a página de tokens mostra o título',
    );
    await visit(page, `/t/${teamUrl}/settings/webhooks`);
    report(
      page.url() === `${baseUrl}/t/${teamUrl}/settings/webhooks`,
      `o ADMIN abre /settings/webhooks (${page.url()})`,
    );
    await context.close();
  });

  await finish();
}

// ---- Menu do computador ----------------------------------------------------------------------------------------------
await section('menu do computador', async () => {
  const { context, page } = await openAs();

  await visit(page, `/t/${teamUrl}/documents`);
  await page.getByTestId('menu-switcher').waitFor();

  const links = await page
    .locator('header a[href]')
    .evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href')));

  report(links.includes(`/t/${teamUrl}/documents`), 'o menu do computador tem Documentos');
  report(links.includes('/notas-fiscais'), 'o menu do computador tem Notas fiscais');
  report(!links.some((href) => /\/templates/.test(href ?? '')), 'o menu do computador não tem Modelos');
  report(!TEMPLATES.test(await page.locator('header').innerText()), 'o cabeçalho não escreve Modelos/Templates');
  await shot(page, '01-menu-computador');

  // Menu da conta: Idioma e Suporte saem; Configurações, Conta e Sair ficam; criar organização fica.
  await page.getByTestId('menu-switcher').click();
  await page.getByRole('menuitem').first().waitFor();

  const items = await texts(page.getByRole('menuitem'));

  report(
    items.length > 0 && items.some((text) => /^(Sign Out|Sair)$/i.test(text)),
    `o menu da conta abriu (${items.join(', ')})`,
  );
  report(!items.some((text) => LANGUAGE.test(text)), 'o menu da conta não tem Idioma');
  report(!items.some((text) => SUPPORT.test(text)), 'o menu da conta não tem Suporte');
  report(
    items.some((text) => /^(Settings|Configura)/i.test(text)),
    'o menu da conta mantém Configurações',
  );
  report(
    (await page.getByText(/Create Organisation|Criar organiza/i).count()) > 0,
    'o menu da conta mantém Criar organização',
  );
  await shot(page, '02-menu-da-conta');
  await page.keyboard.press('Escape');

  // Busca (Ctrl+K): sem categoria de Modelos, sem "Alterar idioma"; com Documentos (controle positivo).
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog').waitFor();

  const palette = await page.getByRole('dialog').innerText();

  report(/Document|Documento/i.test(palette), 'a busca abre com a categoria de Documentos');
  report(!TEMPLATES.test(palette), 'a busca não oferece Modelos');
  report(!/Change language|Alterar idioma|Mudar idioma/i.test(palette), 'a busca não oferece trocar o idioma');
  await shot(page, '03-busca');
  await context.close();
});

// ---- Menu do celular -------------------------------------------------------------------------------------------------
await section('menu do celular', async () => {
  const { context, page } = await openAs({ width: 360, height: 740 });

  await visit(page, `/t/${teamUrl}/documents`);
  await page.locator('header button').last().click();

  const sheet = page.getByRole('dialog');

  await sheet.waitFor();

  const mobileLinks = await sheet
    .locator('a[href]')
    .evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href')));

  report(mobileLinks.includes(`/t/${teamUrl}/documents`), 'o menu do celular tem Documentos');
  report(mobileLinks.includes('/notas-fiscais'), 'o menu do celular tem Notas fiscais');
  report(!mobileLinks.some((href) => /\/templates/.test(href ?? '')), 'o menu do celular não tem Modelos');
  await shot(page, '04-menu-celular');
  await context.close();
});

// ---- Configurações ---------------------------------------------------------------------------------------------------
await section('configurações', async () => {
  const { context, page } = await openAs();

  await visit(page, `/t/${teamUrl}/settings/general`);

  // Se ainda existir um grupo "Preferências" (recolhido), abre antes de ler: as páginas escondidas ficam dentro dele.
  for (const group of await page.locator('[data-testid$="-preferences"]').all()) {
    await group.click();
  }

  const teamNav = await page
    .locator('[data-testid^="unified-settings-nav-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));

  for (const keep of ['team-general', 'team-members', 'team-groups', 'team-reminders', 'organisation-teams']) {
    report(teamNav.includes(`unified-settings-nav-${keep}`), `as configurações mantêm ${keep}`);
  }

  for (const hidden of [
    'preferences',
    'branding',
    'email',
    'document',
    'certificates',
    'public-profile',
    'tokens',
    'webhooks',
  ]) {
    report(
      !teamNav.some((id) => id?.endsWith(`-${hidden}`)),
      `as configurações não têm ${hidden} (${teamNav.filter((id) => id?.endsWith(`-${hidden}`)).join(', ') || 'ausente'})`,
    );
  }

  await shot(page, '05-configuracoes-time');

  // Página escondida aberta pelo endereço: cai nos documentos (time) ou nas configurações gerais (organização).
  await visit(page, `/t/${teamUrl}/settings/branding`);
  report(page.url() === `${baseUrl}/t/${teamUrl}/documents`, `/settings/branding no navegador cai em ${page.url()}`);
  await visit(page, `/t/${teamUrl}/templates`);
  report(page.url() === `${baseUrl}/t/${teamUrl}/documents`, `/templates no navegador cai em ${page.url()}`);
  await visit(page, `/o/${orgUrl}/settings/email`);
  report(
    page.url() === `${baseUrl}/o/${orgUrl}/settings/general`,
    `/o/.../settings/email no navegador cai em ${page.url()}`,
  );
  await context.close();
});

// ---- Lista de documentos e página do documento: sem "Salvar como modelo" ---------------------------------------------
await section('lista de documentos', async () => {
  const { context, page } = await openAs();

  await visit(page, `/t/${teamUrl}/documents`);
  await page.getByTestId('document-table-action-btn').first().click();

  const rowMenu = await page.getByRole('menu').innerText();

  report(/Duplicate|Duplicar/i.test(rowMenu), 'o menu da linha do documento abriu (tem Duplicar)');
  report(!SAVE_AS_TEMPLATE.test(rowMenu), 'o menu da linha do documento não tem Salvar como modelo');
  await shot(page, '06-menu-da-linha');
  await page.keyboard.press('Escape');
  await context.close();
});

// ---- Editor: sem IA, sem Assistente, sem Salvar como modelo ----------------------------------------------------------
await section('editor', async () => {
  const { context, page } = await openAs({ width: 1440, height: 1000 });

  await visit(page, `/t/${teamUrl}/documents/${draftId}/edit`);
  await page
    .getByText(/Add Myself|Adicionar a mim|Adicionar eu/i)
    .first()
    .waitFor();

  report(
    (await page.locator('svg.lucide-sparkles').count()) === 0,
    'o editor não tem o botão de IA (ícone de faíscas)',
  );
  report(
    !AI_BUTTON.test(await page.locator('body').innerText()),
    'o editor não escreve "Detectar destinatários/campos com IA"',
  );
  report(!SAVE_AS_TEMPLATE.test(await page.locator('body').innerText()), 'o editor não oferece Salvar como modelo');
  await shot(page, '07-editor-destinatarios');

  // Seletor de papel: Precisa assinar e os outros ficam; "Pode preparar" (Assistente) sai.
  await page.locator('button[title="SIGNER"]').first().click();

  const roles = await page.getByRole('listbox').innerText();

  report(
    /Needs to sign|Precisa assinar/i.test(roles),
    `o seletor de papel abriu (${roles.replace(/\s+/g, ' ').slice(0, 120)})`,
  );
  report(!ASSISTANT.test(roles), 'o seletor de papel não tem o papel Assistente');
  await shot(page, '08-seletor-de-papel');
  await page.keyboard.press('Escape');

  await visit(page, `/t/${teamUrl}/documents/${draftId}/edit?step=addFields`);
  await page.getByTestId('envelope-editor-step-addFields').waitFor();
  report(
    (await page.locator('svg.lucide-sparkles').count()) === 0,
    'a etapa de campos não tem o botão "Detectar com IA"',
  );
  report(!AI_BUTTON.test(await page.locator('body').innerText()), 'a etapa de campos não escreve "Detectar com IA"');
  await shot(page, '09-editor-campos');

  // `?ai=true` é o que o envio de arquivo adicionava quando a IA estava ligada: não pode abrir nenhum diálogo.
  await visit(page, `/t/${teamUrl}/documents/${draftId}/edit?ai=true`);
  await page
    .getByText(/Add Myself|Adicionar a mim|Adicionar eu/i)
    .first()
    .waitFor();
  report((await page.getByRole('dialog').count()) === 0, 'o editor com ?ai=true não abre diálogo de IA');
  await context.close();
});

await finish();
