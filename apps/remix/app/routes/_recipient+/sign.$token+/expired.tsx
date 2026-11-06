import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { loadRecipientBrandingByTeamId } from '@documenso/lib/server-only/branding/load-recipient-branding';
import { getDocumentAndSenderByToken } from '@documenso/lib/server-only/document/get-document-by-token';
import { isRecipientAuthorized } from '@documenso/lib/server-only/document/is-recipient-authorized';
import { getRecipientByToken } from '@documenso/lib/server-only/recipient/get-recipient-by-token';
import { isRevalleGatePendingForToken } from '@documenso/lib/server-only/revalle/gate/get-gate-state-for-loader'; // REVALLE:
import { Button } from '@documenso/ui/primitives/button';
import { Trans } from '@lingui/react/macro';
import { TimerOffIcon } from 'lucide-react';
import { Link } from 'react-router';
import { getOptionalLoaderContext } from 'server/utils/get-loader-session'; // REVALLE:
import { DocumentSigningAuthPageView } from '~/components/general/document-signing/document-signing-auth-page';
import { RecipientBranding } from '~/components/general/recipient-branding';
import { GateStatusIcon } from '~/components/revalle/signing-gate/gate-status-icon'; // REVALLE:
import { SigningPageFrame } from '~/components/revalle/signing-gate/signing-band'; // REVALLE:
import { useCspNonce } from '~/utils/nonce';

import type { Route } from './+types/expired';

export async function loader({ params, request }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  const { token } = params;

  if (!token) {
    throw new Response('Not Found', { status: 404 });
  }

  const document = await getDocumentAndSenderByToken({
    token,
    requireAccessAuth: false,
  }).catch(() => null);

  if (!document) {
    throw new Response('Not Found', { status: 404 });
  }

  const branding = await loadRecipientBrandingByTeamId({ teamId: document.teamId });

  // REVALLE: sem o título enquanto o portão não foi passado.
  const title = (await isRevalleGatePendingForToken(token, getOptionalLoaderContext().requestMetadata))
    ? null
    : document.title;

  const recipient = await getRecipientByToken({ token }).catch(() => null);

  if (!recipient) {
    throw new Response('Not Found', { status: 404 });
  }

  const isDocumentAccessValid = await isRecipientAuthorized({
    type: 'ACCESS',
    documentAuthOptions: document.authOptions,
    recipient,
    userId: user?.id,
  });

  const recipientEmail = recipient.email;

  if (isDocumentAccessValid) {
    return {
      isDocumentAccessValid: true,
      recipientEmail,
      title,
      branding,
    };
  }

  return {
    isDocumentAccessValid: false,
    recipientEmail,
    branding,
  };
}

export default function ExpiredSigningPage({ loaderData }: Route.ComponentProps) {
  const { sessionData } = useOptionalSession();
  const user = sessionData?.user;
  const cspNonce = useCspNonce();

  const { isDocumentAccessValid, recipientEmail, title, branding } = loaderData;

  if (!isDocumentAccessValid) {
    return (
      <>
        <RecipientBranding branding={branding} cspNonce={cspNonce} />
        <DocumentSigningAuthPageView email={recipientEmail} />
      </>
    );
  }

  // REVALLE (redesign v3): faixa azul + um cartão. O título só aparece depois do portão (como antes).
  return (
    <>
      <RecipientBranding branding={branding} cspNonce={cspNonce} />
      <SigningPageFrame
        titleAs="p"
        title={
          title ? (
            <span title={title} className="line-clamp-2">
              {title}
            </span>
          ) : undefined
        }
      >
        <div className="flex flex-col items-center text-center">
          <GateStatusIcon icon={TimerOffIcon} tone="warning" />

          <h1 className="mt-4 font-black font-display text-[26px] leading-tight tracking-[-0.02em]">
            <Trans>Signing Deadline Expired</Trans>
          </h1>

          <p className="mt-3 max-w-[46ch] text-[14.5px] text-muted-foreground">
            <Trans>
              The signing deadline for this document has passed. Please contact the document owner if you need a new
              copy to sign.
            </Trans>
          </p>

          {user && (
            <Button className="mt-6 w-full" size="lg" asChild>
              <Link to={`/`}>
                <Trans>Return Home</Trans>
              </Link>
            </Button>
          )}
        </div>
      </SigningPageFrame>
    </>
  );
}
