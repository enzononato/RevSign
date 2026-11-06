import { authClient } from '@documenso/auth/client';
import { useIsFramed } from '@documenso/lib/client-only/hooks/use-is-framed';
import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { formatPath } from '@documenso/lib/constants/app';
import { Button } from '@documenso/ui/primitives/button';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { LogInIcon } from 'lucide-react';
import { useState } from 'react';

import { EmbedPopupAuth } from '~/components/embed/embed-popup-auth';
import { GateStatusIcon } from '~/components/revalle/signing-gate/gate-status-icon'; // REVALLE:
import { SigningPageFrame } from '~/components/revalle/signing-gate/signing-band'; // REVALLE:

export type DocumentSigningAuthPageViewProps = {
  email?: string;
  emailHasAccount?: boolean;
};

export const DocumentSigningAuthPageView = ({ email, emailHasAccount }: DocumentSigningAuthPageViewProps) => {
  const { _ } = useLingui();
  const { toast } = useToast();

  const isFramed = useIsFramed();

  const { sessionData } = useOptionalSession();

  const [isSigningOut, setIsSigningOut] = useState(false);

  const mismatchedUserEmail =
    sessionData?.user && email && sessionData.user.email !== email ? sessionData.user.email : undefined;

  const handleChangeAccount = async (email?: string) => {
    try {
      setIsSigningOut(true);

      let redirectPath = formatPath('/signin');

      if (email) {
        redirectPath = emailHasAccount ? formatPath(`/signin#email=${email}`) : formatPath(`/signup#email=${email}`);
      }

      await authClient.signOut({
        redirectPath,
      });
    } catch {
      toast({
        title: _(msg`Something went wrong`),
        description: _(msg`We were unable to log you out at this time.`),
        duration: 10000,
        variant: 'destructive',
      });
    }

    setIsSigningOut(false);
  };

  // REVALLE (redesign v3): faixa azul + um cartão, como as outras telas públicas de quem assina.
  return (
    <SigningPageFrame>
      <div className="w-full">
        <GateStatusIcon icon={LogInIcon} tone="brand" />

        <h1 className="mt-4 font-black font-display text-[23px] leading-tight tracking-[-0.02em]">
          <Trans>Authentication required</Trans>
        </h1>

        <p className="mt-2 text-muted-foreground">
          {email ? (
            <Trans>
              You need to be logged in as <strong className="break-all text-foreground">{email}</strong> to view this
              page.
            </Trans>
          ) : (
            <Trans>You need to be logged in to view this page.</Trans>
          )}
        </p>

        {isFramed ? (
          <EmbedPopupAuth
            className="mt-5"
            email={email || undefined}
            signedInAs={mismatchedUserEmail}
            onSuccess={() => window.location.reload()}
          />
        ) : (
          <Button
            className="mt-5 w-full"
            size="lg"
            type="submit"
            onClick={async () => handleChangeAccount(email)}
            loading={isSigningOut}
          >
            {emailHasAccount ? <Trans>Login</Trans> : <Trans>Sign up</Trans>}
          </Button>
        )}
      </div>
    </SigningPageFrame>
  );
};
