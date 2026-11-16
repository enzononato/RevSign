import { rememberSigningReturnTo, sanitizeSigningReturnTo } from '@documenso/lib/revalle/account-required/return-to'; // REVALLE:
import { Trans } from '@lingui/react/macro';
import { Mails } from 'lucide-react';
import { useEffect } from 'react'; // REVALLE:

import { SendConfirmationEmailForm } from '~/components/forms/send-confirmation-email';

import type { Route } from './+types/unverified-account'; // REVALLE:

// REVALLE: vindo do link de assinatura (conta obrigatória para o e-mail da empresa), a volta para o documento fica
// guardada no navegador até a confirmação do e-mail. Só `/sign/<token>` é aceito.
export function loader({ request }: Route.LoaderArgs) {
  return {
    signingReturnTo: sanitizeSigningReturnTo(new URL(request.url).searchParams.get('returnTo')),
  };
}

export default function UnverifiedAccount({ loaderData }: Route.ComponentProps) {
  const { signingReturnTo } = loaderData; // REVALLE:

  // REVALLE:
  useEffect(() => {
    rememberSigningReturnTo(signingReturnTo);
  }, [signingReturnTo]);

  return (
    <div className="w-full">
      <div className="flex flex-col">
        <div className="mb-4">
          <Mails className="h-10 w-10 text-primary" strokeWidth={2} />
        </div>
        <div className="">
          <h2 className="text-[30px] leading-tight">
            <Trans>Confirm email</Trans>
          </h2>

          <p className="mt-4 text-muted-foreground">
            <Trans>
              To gain access to your account, please confirm your email address by clicking on the confirmation link
              from your inbox.
            </Trans>
          </p>

          {/* REVALLE: conta obrigatória: o documento espera a confirmação */}
          {signingReturnTo && (
            <p className="mt-4 text-muted-foreground">
              <Trans>
                Para assinar, confirme o e-mail primeiro. Ao abrir o link de confirmação neste navegador, você volta
                direto ao documento; em outro aparelho, abra de novo o link do e-mail do documento.
              </Trans>
            </p>
          )}

          <p className="mt-4 text-muted-foreground">
            <Trans>If you don't find the confirmation link in your inbox, you can request a new one below.</Trans>
          </p>

          <SendConfirmationEmailForm />
        </div>
      </div>
    </div>
  );
}
