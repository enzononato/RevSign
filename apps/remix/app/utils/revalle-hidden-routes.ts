import { getSession } from '@documenso/auth/server/lib/utils/get-session';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { redirect } from 'react-router';

// Fase 7, Task 9 (spec §6): páginas que saíram da tela mas continuam no código do upstream. Quem abre o endereço
// direto cai numa página que existe, em vez de ver uma tela vazia ou uma que o servidor vai recusar. Os loaders rodam
// depois do `authenticatedMiddleware` do layout `_authenticated+`, então quem não entrou continua indo para o login.

type TeamParams = { params: { teamUrl?: string } };
type OrganisationParams = { params: { orgUrl?: string } };

const teamHome = (teamUrl: string | undefined) => `/t/${teamUrl}/documents`;

/** Página do time que saiu para todos (marca, e-mail, documento, certificado, perfil público, modelos). */
export const redirectHiddenTeamPage = ({ params }: TeamParams): never => {
  throw redirect(teamHome(params.teamUrl));
};

/** Página da organização que saiu para todos (marca, e-mail, documento, certificado). */
export const redirectHiddenOrganisationPage = ({ params }: OrganisationParams): never => {
  throw redirect(`/o/${params.orgUrl}/settings/general`);
};

/** Página do time que só o administrador do sistema abre (tokens de API e webhooks). */
export const redirectTeamPageUnlessAdmin = async ({ request, params }: TeamParams & { request: Request }) => {
  const { user } = await getSession(request);

  if (!isAdmin(user)) {
    throw redirect(teamHome(params.teamUrl));
  }

  return null;
};
