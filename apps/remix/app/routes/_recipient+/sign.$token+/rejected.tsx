import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { loadRecipientBrandingByTeamId } from '@documenso/lib/server-only/branding/load-recipient-branding';
import { getDocumentAndSenderByToken } from '@documenso/lib/server-only/document/get-document-by-token';
import { isRecipientAuthorized } from '@documenso/lib/server-only/document/is-recipient-authorized';
import { getFieldsForToken } from '@documenso/lib/server-only/field/get-fields-for-token';
import { getRecipientByToken } from '@documenso/lib/server-only/recipient/get-recipient-by-token';
import {
  getRevalleGateLoaderPayload, // REVALLE:
  isRevalleGatePendingForToken, // REVALLE:
} from '@documenso/lib/server-only/revalle/gate/get-gate-state-for-loader'; // REVALLE:
import { Button } from '@documenso/ui/primitives/button';
import { Trans } from '@lingui/react/macro';
import { FieldType } from '@prisma/client';
import { XCircle } from 'lucide-react';
import { Link, redirect } from 'react-router'; // REVALLE: redirect

import { getOptionalLoaderContext } from 'server/utils/get-loader-session'; // REVALLE:
import { DocumentSigningAuthPageView } from '~/components/general/document-signing/document-signing-auth-page';
import { RecipientBranding } from '~/components/general/recipient-branding';
import { GateStatusIcon } from '~/components/revalle/signing-gate/gate-status-icon'; // REVALLE:
import { SigningPageFrame } from '~/components/revalle/signing-gate/signing-band'; // REVALLE:
import { useCspNonce } from '~/utils/nonce';
import { truncateTitle } from '~/utils/truncate-title';

import type { Route } from './+types/rejected';

export async function loader({ params, request }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  const { token } = params;

  if (!token) {
    throw new Response('Not Found', { status: 404 });
  }

  // REVALLE: nada do documento antes do portão; a tela do portão fica em /sign/<token>.
  const { requestMetadata } = getOptionalLoaderContext();

  if (await isRevalleGatePendingForToken(token, requestMetadata)) {
    if (await getRevalleGateLoaderPayload(token, requestMetadata)) {
      throw redirect(`/sign/${token}`);
    }

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

  const truncatedTitle = truncateTitle(document.title);

  const [fields, recipient] = await Promise.all([
    getFieldsForToken({ token }),
    getRecipientByToken({ token }).catch(() => null),
  ]);

  if (!recipient) {
    throw new Response('Not Found', { status: 404 });
  }

  const isDocumentAccessValid = await isRecipientAuthorized({
    type: 'ACCESS',
    documentAuthOptions: document.authOptions,
    recipient,
    userId: user?.id,
  });

  const recipientReference =
    recipient.name || fields.find((field) => field.type === FieldType.NAME)?.customText || recipient.email;

  if (isDocumentAccessValid) {
    return {
      isDocumentAccessValid: true,
      recipientReference,
      truncatedTitle,
      title: document.title, // REVALLE: título inteiro na faixa (quebra em até duas linhas)
      branding,
    };
  }

  // Don't leak data if access is denied.
  return {
    isDocumentAccessValid: false,
    recipientReference,
    branding,
  };
}

export default function RejectedSigningPage({ loaderData }: Route.ComponentProps) {
  const { sessionData } = useOptionalSession();
  const user = sessionData?.user;
  const cspNonce = useCspNonce();

  const { isDocumentAccessValid, recipientReference, title, branding } = loaderData;

  if (!isDocumentAccessValid) {
    return (
      <>
        <RecipientBranding branding={branding} cspNonce={cspNonce} />
        <DocumentSigningAuthPageView email={recipientReference} />
      </>
    );
  }

  // REVALLE (redesign v3): faixa azul + um cartão.
  return (
    <>
      <RecipientBranding branding={branding} cspNonce={cspNonce} />
      <SigningPageFrame
        titleAs="p"
        title={
          <span title={title} className="line-clamp-2">
            {title}
          </span>
        }
      >
        <div className="flex flex-col items-center text-center">
          <GateStatusIcon icon={XCircle} tone="danger" />

          <h1 className="mt-4 font-black font-display text-[26px] leading-tight tracking-[-0.02em]">
            <Trans>Document Rejected</Trans>
          </h1>

          <span className="mt-3 inline-flex min-h-7 items-center rounded-full bg-danger-bg px-3 py-1 font-semibold text-[13px] text-destructive">
            <Trans>You have rejected this document</Trans>
          </span>

          <p className="mt-4 max-w-[46ch] text-[14.5px] text-muted-foreground">
            <Trans>
              The document owner has been notified of your decision. They may contact you with further instructions if
              necessary.
            </Trans>
          </p>

          <p className="mt-2 max-w-[46ch] text-[14.5px] text-muted-foreground">
            <Trans>No further action is required from you at this time.</Trans>
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
