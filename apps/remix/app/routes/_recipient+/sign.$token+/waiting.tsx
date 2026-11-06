import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { loadRecipientBrandingByTeamId } from '@documenso/lib/server-only/branding/load-recipient-branding';
import { getDocumentAndSenderByToken } from '@documenso/lib/server-only/document/get-document-by-token';
import { getEnvelopeById } from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import { getRecipientByToken } from '@documenso/lib/server-only/recipient/get-recipient-by-token';
import { getTeamById } from '@documenso/lib/server-only/team/get-team';
import { formatDocumentsPath } from '@documenso/lib/utils/teams';
import { Button } from '@documenso/ui/primitives/button';
import { Trans } from '@lingui/react/macro';
import type { Team } from '@prisma/client';
import { DocumentStatus, EnvelopeType } from '@prisma/client';
import { HourglassIcon } from 'lucide-react'; // REVALLE:
import { Link, redirect } from 'react-router';

import { RecipientBranding } from '~/components/general/recipient-branding';
import { GateStatusIcon } from '~/components/revalle/signing-gate/gate-status-icon'; // REVALLE:
import { SigningPageFrame } from '~/components/revalle/signing-gate/signing-band'; // REVALLE:
import { useCspNonce } from '~/utils/nonce';

import type { Route } from './+types/waiting';

export async function loader({ params, request }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  const { token } = params;

  if (!token) {
    throw new Response('Not Found', { status: 404 });
  }

  const [document, recipient] = await Promise.all([
    getDocumentAndSenderByToken({ token }).catch(() => null),
    getRecipientByToken({ token }).catch(() => null),
  ]);

  if (!document || !recipient) {
    throw new Response('Not Found', { status: 404 });
  }

  if (document.status === DocumentStatus.COMPLETED) {
    throw redirect(`/sign/${token}/complete`);
  }

  let isOwnerOrTeamMember = false;

  let team: Team | null = null;

  if (user) {
    isOwnerOrTeamMember = await getEnvelopeById({
      id: {
        type: 'documentId',
        id: document.id,
      },
      type: EnvelopeType.DOCUMENT,
      userId: user.id,
      teamId: document.teamId ?? undefined,
    })
      .then((envelope) => !!envelope)
      .catch(() => false);

    if (document.teamId) {
      team = await getTeamById({
        userId: user.id,
        teamId: document.teamId,
      });
    }
  }

  const documentPathForEditing = isOwnerOrTeamMember && team ? formatDocumentsPath(team.url) + '/' + document.id : null;

  const branding = await loadRecipientBrandingByTeamId({ teamId: document.teamId });

  return {
    documentPathForEditing,
    branding,
  };
}

export default function WaitingForTurnToSignPage({ loaderData }: Route.ComponentProps) {
  const { documentPathForEditing, branding } = loaderData;
  const cspNonce = useCspNonce();

  // REVALLE (redesign v3): faixa azul + um cartão.
  return (
    <>
      <RecipientBranding branding={branding} cspNonce={cspNonce} />
      <SigningPageFrame>
        <div className="flex flex-col items-center text-center">
          <GateStatusIcon icon={HourglassIcon} tone="warning" />

          <h1 className="mt-4 font-black font-display text-[26px] leading-tight tracking-[-0.02em]">
            <Trans>Waiting for Your Turn</Trans>
          </h1>

          <p className="mt-3 max-w-[46ch] text-[14.5px] text-muted-foreground">
            <Trans>
              It's currently not your turn to sign. You will receive an email with instructions once it's your turn to
              sign the document.
            </Trans>
          </p>

          <p className="mt-2 max-w-[46ch] text-[14.5px] text-muted-foreground">
            <Trans>Please check your email for updates.</Trans>
          </p>

          <div className="mt-4">
            {documentPathForEditing ? (
              <Button variant="link" className="min-h-11" asChild>
                <Link to={documentPathForEditing}>
                  <Trans>Were you trying to edit this document instead?</Trans>
                </Link>
              </Button>
            ) : (
              <Button variant="link" className="min-h-11" asChild>
                <Link to="/">
                  <Trans>Return Home</Trans>
                </Link>
              </Button>
            )}
          </div>
        </div>
      </SigningPageFrame>
    </>
  );
}
