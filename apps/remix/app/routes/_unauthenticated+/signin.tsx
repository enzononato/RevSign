import { authClient } from '@documenso/auth/client';
import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import {
  IS_GOOGLE_SSO_ENABLED,
  IS_MICROSOFT_SSO_ENABLED,
  IS_OIDC_AUTO_REDIRECT_DISABLED,
  IS_OIDC_SSO_ENABLED,
  isSigninEnabledForProvider,
  isSignupEnabledForProvider,
  OIDC_PROVIDER_LABEL,
} from '@documenso/lib/constants/auth';
import { sanitizeSigningReturnTo } from '@documenso/lib/revalle/account-required/return-to'; // REVALLE:
import { isValidReturnTo, normalizeReturnTo } from '@documenso/lib/utils/is-valid-return-to';
import { Alert, AlertDescription } from '@documenso/ui/primitives/alert';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { Loader2Icon } from 'lucide-react';
import { useEffect } from 'react';
import { Link, redirect, useSearchParams } from 'react-router';

import { SignInForm } from '~/components/forms/signin';
import { SIGNUP_ERROR_MESSAGES } from '~/components/forms/signup';
import { appMetaTags } from '~/utils/meta';

import type { Route } from './+types/signin';

export function meta() {
  return appMetaTags(msg`Sign In`);
}

export async function loader({ request }: Route.LoaderArgs) {
  const { session } = await getOptionalSession(request);

  // Embed sessions are rejected by the authenticated tree, so treat them as signed out here.
  const isAuthenticated = session !== null && !session.isEmbed;

  // SSR env variables.
  const isEmailPasswordSigninEnabled = isSigninEnabledForProvider('email');
  const isGoogleSSOEnabled = IS_GOOGLE_SSO_ENABLED && isSigninEnabledForProvider('google');
  const isMicrosoftSSOEnabled = IS_MICROSOFT_SSO_ENABLED && isSigninEnabledForProvider('microsoft');
  const isOIDCSSOEnabled = IS_OIDC_SSO_ENABLED && isSigninEnabledForProvider('oidc');

  // Automatically redirect to OIDC when it is the only enabled signin transport,
  // unless the redirect has been explicitly disabled via env.
  const isOIDCOnlyTransport =
    isOIDCSSOEnabled && !isEmailPasswordSigninEnabled && !isGoogleSSOEnabled && !isMicrosoftSSOEnabled;

  const shouldAutoRedirectToOIDC = isOIDCOnlyTransport && !IS_OIDC_AUTO_REDIRECT_DISABLED;

  const oidcProviderLabel = OIDC_PROVIDER_LABEL;

  const isSignupEnabled =
    isSignupEnabledForProvider('email') ||
    (IS_GOOGLE_SSO_ENABLED && isSignupEnabledForProvider('google')) ||
    (IS_MICROSOFT_SSO_ENABLED && isSignupEnabledForProvider('microsoft')) ||
    (IS_OIDC_SSO_ENABLED && isSignupEnabledForProvider('oidc'));

  const searchParams = new URL(request.url).searchParams; // REVALLE:

  let returnTo = searchParams.get('returnTo') ?? undefined;

  returnTo = isValidReturnTo(returnTo) ? normalizeReturnTo(returnTo) : undefined;

  if (isAuthenticated) {
    throw redirect(returnTo || '/');
  }

  // REVALLE: vindo do link de assinatura (conta obrigatória para o e-mail da empresa): e-mail preenchido e o aviso de
  // que a pessoa volta ao documento. O e-mail só preenche o campo; nada é decidido por ele.
  const revalleSigningReturnTo = sanitizeSigningReturnTo(returnTo);
  const revalleEmail = (searchParams.get('email') ?? '').trim().slice(0, 254) || undefined;

  return {
    isEmailPasswordSigninEnabled,
    isGoogleSSOEnabled,
    isMicrosoftSSOEnabled,
    isOIDCSSOEnabled,
    isSignupEnabled,
    oidcProviderLabel,
    returnTo,
    shouldAutoRedirectToOIDC,
    revalleSigningReturnTo, // REVALLE:
    revalleEmail, // REVALLE:
  };
}

export default function SignIn({ loaderData }: Route.ComponentProps) {
  const {
    isEmailPasswordSigninEnabled,
    isGoogleSSOEnabled,
    isMicrosoftSSOEnabled,
    isOIDCSSOEnabled,
    isSignupEnabled,
    oidcProviderLabel,
    returnTo,
    shouldAutoRedirectToOIDC,
    revalleSigningReturnTo,
    revalleEmail,
  } = loaderData;

  const { _ } = useLingui();

  const [searchParams] = useSearchParams();

  const errorParam = searchParams.get('error');
  const signupError = errorParam ? SIGNUP_ERROR_MESSAGES[errorParam] : undefined;

  useEffect(() => {
    if (!shouldAutoRedirectToOIDC) {
      return;
    }

    void authClient.oidc.signIn({ redirectPath: returnTo ?? '/' });
  }, [shouldAutoRedirectToOIDC, returnTo]);

  if (shouldAutoRedirectToOIDC) {
    return (
      <div className="w-full">
        <div className="flex flex-col items-center justify-center gap-y-4 py-12">
          <Loader2Icon className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-muted-foreground text-sm">
            <Trans>Redirecting to {oidcProviderLabel || 'OIDC'}...</Trans>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="z-10">
        {signupError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{_(signupError)}</AlertDescription>
          </Alert>
        )}

        <h1 className="text-[30px] leading-tight">
          <Trans>Sign in to your account</Trans>
        </h1>

        <p className="mt-2 text-muted-foreground text-sm">
          {/* REVALLE: vindo do link de assinatura, o texto diz o que acontece depois de entrar */}
          {revalleSigningReturnTo ? (
            <Trans>
              Entre com a sua conta do RevSign para assinar. Depois de entrar, você volta direto ao documento.
            </Trans>
          ) : (
            <Trans>Welcome back, we are lucky to have you.</Trans>
          )}
        </p>
        <div className="my-5" />

        <SignInForm
          isEmailPasswordSigninEnabled={isEmailPasswordSigninEnabled}
          isGoogleSSOEnabled={isGoogleSSOEnabled}
          isMicrosoftSSOEnabled={isMicrosoftSSOEnabled}
          isOIDCSSOEnabled={isOIDCSSOEnabled}
          oidcProviderLabel={oidcProviderLabel}
          returnTo={returnTo}
          initialEmail={revalleEmail} // REVALLE:
        />

        {isSignupEnabled && (
          <p className="mt-6 text-center text-muted-foreground text-sm">
            <Trans>
              Don't have an account?{' '}
              <Link
                to={revalleSignupPath({ returnTo, email: revalleEmail })} // REVALLE: mantém o e-mail do link de assinatura
                className="text-brand-text duration-200 hover:opacity-70"
              >
                Sign up
              </Link>
            </Trans>
          </p>
        )}
      </div>
    </div>
  );
}

// REVALLE: o link "Criar conta" leva a volta e, vindo do link de assinatura, o e-mail.
const revalleSignupPath = ({ returnTo, email }: { returnTo?: string; email?: string }) => {
  const params = new URLSearchParams();

  if (email && sanitizeSigningReturnTo(returnTo)) {
    params.set('email', email);
  }

  if (returnTo) {
    params.set('returnTo', returnTo);
  }

  const query = params.toString();

  return query ? `/signup?${query}` : '/signup';
};
