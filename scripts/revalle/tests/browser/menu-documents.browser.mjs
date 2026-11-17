// REVALLE (v.20): chamado por `menu-documents.test.mjs` (ver `shared.mjs`). Confere, no navegador, o item "Documentos"
// do menu lateral fora das páginas de time: com dois times vai ao que não é o pessoal; depois de abrir o time pessoal e
// voltar a Notas fiscais pelo menu (sem recarregar) e recarregando, vai ao pessoal; com um time, vai a ele; e a conta
// recuperada (sem organização até entrar) vê o item. Sem erro de hidratação no console.
//
// Entrada: a URL e as contas (`twoTeams`: cookie, personalTeamUrl, otherTeamUrl; `oneTeam`: cookie, teamUrl; `healed`:
// cookie, teamUrl ou null).
import { finish, openAs, payload, report, section, shot } from './shared.mjs';

const { baseUrl, twoTeams, oneTeam, healed } = payload;

const HYDRATION = /hydrat|did not match|server rendered/i;

const href = (teamUrl) => `/t/${teamUrl}/documents`;

const mainNav = (page) => page.getByRole('navigation', { name: 'Navegação principal' });

const documentsHref = async (page) => {
  const link = mainNav(page).getByRole('link', { name: 'Documentos', exact: true });

  await link.waitFor();

  return await link.getAttribute('href');
};

const visit = async (page, route) => {
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
};

const watchHydration = (page) => {
  const errors = [];

  page.on('console', (message) => {
    if (message.type() === 'error' && HYDRATION.test(message.text())) {
      errors.push(message.text().split('\n')[0]);
    }
  });
  page.on('pageerror', (error) => {
    if (HYDRATION.test(error.message)) {
      errors.push(error.message.split('\n')[0]);
    }
  });

  return errors;
};

await section('dois times', async () => {
  const { context, page } = await openAs(twoTeams.cookie);
  const hydration = watchHydration(page);

  await visit(page, '/notas-fiscais');

  const first = await documentsHref(page);

  report(
    first === href(twoTeams.otherTeamUrl),
    `dois times, nunca abriu um: Documentos vai ao time não pessoal (${first})`,
  );
  await shot(page, 'menu-dois-times');

  // Abre o time pessoal e volta a Notas fiscais pelo menu, sem recarregar.
  await visit(page, href(twoTeams.personalTeamUrl));
  await mainNav(page).getByRole('link', { name: 'Notas fiscais' }).click();
  await page.waitForURL(/\/notas-fiscais$/);

  const afterNav = await documentsHref(page);

  report(
    afterNav === href(twoTeams.personalTeamUrl),
    `depois de abrir o time pessoal, pelo menu: Documentos vai a ele (${afterNav})`,
  );

  // Recarregando: o servidor lê o cookie e já manda o link certo.
  await visit(page, '/notas-fiscais');

  const afterReload = await documentsHref(page);

  report(
    afterReload === href(twoTeams.personalTeamUrl),
    `depois de abrir o time pessoal, recarregando: Documentos vai a ele (${afterReload})`,
  );

  // Clicar em Documentos abre a lista do time.
  await mainNav(page).getByRole('link', { name: 'Documentos', exact: true }).click();
  await page.waitForURL(new RegExp(`${href(twoTeams.personalTeamUrl)}$`));
  report(true, 'clicar em Documentos abre os documentos do time');
  await shot(page, 'menu-dois-times-pessoal');

  report(hydration.length === 0, `sem erro de hidratação (${hydration.join(' | ') || 'nenhum'})`);
  await context.close();
});

await section('um time', async () => {
  const { context, page } = await openAs(oneTeam.cookie);

  await visit(page, '/notas-fiscais');

  const value = await documentsHref(page);

  report(value === href(oneTeam.teamUrl), `um time: Documentos vai a ele (${value})`);
  await context.close();
});

if (healed) {
  await section('conta recuperada', async () => {
    const { context, page } = await openAs(healed.cookie);

    await visit(page, '/notas-fiscais');

    const value = await documentsHref(page);

    report(
      value === href(healed.teamUrl),
      `conta sem organização, ao entrar: Documentos vai ao time pessoal (${value})`,
    );
    await context.close();
  });
} else {
  report(false, 'conta recuperada: o teste da conta sem organização não passou, sem conta para abrir');
}

await finish();
