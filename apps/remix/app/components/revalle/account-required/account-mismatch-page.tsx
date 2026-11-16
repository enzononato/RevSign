import { authClient } from '@documenso/auth/client';
import { formatPath } from '@documenso/lib/constants/app';
import { Button } from '@documenso/ui/primitives/button';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { UserRoundX } from 'lucide-react';
import { useState } from 'react';

import { GateStatusIcon } from '~/components/revalle/signing-gate/gate-status-icon';
import { SigningPageFrame } from '~/components/revalle/signing-gate/signing-band';

export type RevalleAccountMismatchPageProps = {
  /** E-mail que recebeu o documento (da empresa). */
  recipientEmail: string;
  /** E-mail da conta logada agora. */
  sessionEmail: string;
  /** Entrar ou criar a conta do destinatário, com a volta para o documento (`/signin?...` ou `/signup?...`). */
  accountPath: string;
};

/**
 * REVALLE: o documento é para um e-mail da empresa e a pessoa está logada com outra conta. Nada do documento aparece
 * aqui; sair leva a entrar (ou criar a conta) com o e-mail certo e volta ao documento.
 */
export const RevalleAccountMismatchPage = ({
  recipientEmail,
  sessionEmail,
  accountPath,
}: RevalleAccountMismatchPageProps) => {
  const { _ } = useLingui();
  const { toast } = useToast();

  const [isSigningOut, setIsSigningOut] = useState(false);

  const onSwitchAccount = async () => {
    setIsSigningOut(true);

    try {
      await authClient.signOut({ redirectPath: formatPath(accountPath) });
    } catch {
      toast({
        title: _(msg`Something went wrong`),
        description: _(msg`We were unable to log you out at this time.`),
        duration: 10000,
        variant: 'destructive',
      });

      setIsSigningOut(false);
    }
  };

  return (
    <SigningPageFrame>
      <div className="w-full">
        <GateStatusIcon icon={UserRoundX} tone="brand" />

        <h1 className="mt-4 font-black font-display text-[23px] leading-tight tracking-[-0.02em]">
          <Trans>Este documento é para outra conta</Trans>
        </h1>

        <p className="mt-2 text-muted-foreground">
          <Trans>
            Este documento foi enviado para <strong className="break-all text-foreground">{recipientEmail}</strong>.
            Você está conectado como <strong className="break-all text-foreground">{sessionEmail}</strong>.
          </Trans>
        </p>

        <p className="mt-2 text-muted-foreground">
          <Trans>Para assinar, saia e entre com a conta do RevSign de {recipientEmail}.</Trans>
        </p>

        <Button className="mt-5 w-full" size="lg" onClick={onSwitchAccount} loading={isSigningOut}>
          <Trans>Sair e entrar com {recipientEmail}</Trans>
        </Button>
      </div>
    </SigningPageFrame>
  );
};
