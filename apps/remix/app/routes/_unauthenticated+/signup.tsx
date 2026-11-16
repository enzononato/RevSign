import {
  IS_GOOGLE_SSO_ENABLED,
  IS_MICROSOFT_SSO_ENABLED,
  IS_OIDC_SSO_ENABLED,
  isSignupEnabledForProvider,
} from '@documenso/lib/constants/auth';
import { sanitizeSigningReturnTo } from '@documenso/lib/revalle/account-required/return-to'; // REVALLE:
import { getRevalleSignupLockedEmail } from '@documenso/lib/server-only/revalle/account-required/signing-page'; // REVALLE:
import { isSignupIdentityRequired } from '@documenso/lib/server-only/revalle/signup/identity';
import { isValidReturnTo, normalizeReturnTo } from '@documenso/lib/utils/is-valid-return-to';
import { msg } from '@lingui/core/macro';
import { redirect } from 'react-router';

import { SignUpForm } from '~/components/forms/signup';
import { appMetaTags } from '~/utils/meta';

import type { Route } from './+types/signup';

export function meta() {
  return appMetaTags(msg`Sign Up`);
}

export async function loader({ request }: Route.LoaderArgs) {
  const isEmailPasswordSignupEnabled = isSignupEnabledForProvider('email');
  const isGoogleSignupEnabled = IS_GOOGLE_SSO_ENABLED && isSignupEnabledForProvider('google');
  const isMicrosoftSignupEnabled = IS_MICROSOFT_SSO_ENABLED && isSignupEnabledForProvider('microsoft');
  const isOidcSignupEnabled = IS_OIDC_SSO_ENABLED && isSignupEnabledForProvider('oidc');

  const isAnySignupEnabled =
    isEmailPasswordSignupEnabled || isGoogleSignupEnabled || isMicrosoftSignupEnabled || isOidcSignupEnabled;

  if (!isAnySignupEnabled) {
    throw redirect('/signin');
  }

  const searchParams = new URL(request.url).searchParams; // REVALLE:

  let returnTo = searchParams.get('returnTo') ?? undefined;

  returnTo = isValidReturnTo(returnTo) ? normalizeReturnTo(returnTo) : undefined;

  // REVALLE: conta obrigatória para o e-mail da empresa. Vindo do link de assinatura, o e-mail do destinatário vem
  // travado (só quando é mesmo o e-mail daquele link e a conta ainda não existe). O cadastro continua exigindo a
  // confirmação do e-mail antes de qualquer assinatura.
  const revalleSigningReturnTo = sanitizeSigningReturnTo(returnTo);
  const revalleLockedEmail = await getRevalleSignupLockedEmail({
    email: searchParams.get('email'),
    returnTo: revalleSigningReturnTo,
  });

  return {
    isEmailPasswordSignupEnabled,
    isGoogleSignupEnabled,
    isMicrosoftSignupEnabled,
    isOidcSignupEnabled,
    returnTo,
    // REVALLE: cadastro só para colaborador (Fase 7). O e-mail isento (do administrador) não vai para o navegador.
    identityRequired: isSignupIdentityRequired(),
    revalleSigningReturnTo, // REVALLE:
    revalleLockedEmail, // REVALLE:
  };
}

export default function SignUp({ loaderData }: Route.ComponentProps) {
  const {
    isEmailPasswordSignupEnabled,
    isGoogleSignupEnabled,
    isMicrosoftSignupEnabled,
    isOidcSignupEnabled,
    returnTo,
    identityRequired,
    revalleSigningReturnTo,
    revalleLockedEmail,
  } = loaderData;

  return (
    <SignUpForm
      className="w-full"
      isEmailPasswordSignupEnabled={isEmailPasswordSignupEnabled}
      isGoogleSignupEnabled={isGoogleSignupEnabled}
      isMicrosoftSignupEnabled={isMicrosoftSignupEnabled}
      isOidcSignupEnabled={isOidcSignupEnabled}
      returnTo={returnTo}
      identityRequired={identityRequired}
      initialEmail={revalleLockedEmail ?? undefined} // REVALLE:
      emailLocked={!!revalleLockedEmail} // REVALLE:
      signingReturnTo={revalleSigningReturnTo ?? undefined} // REVALLE:
    />
  );
}
