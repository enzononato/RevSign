import { DEFAULT_MINIMUM_ENVELOPE_ITEM_COUNT, PAID_PLAN_LIMITS } from '@documenso/ee/server-only/limits/constants';
import { LimitsProvider } from '@documenso/ee/server-only/limits/provider/client';
import { useChildRouteFlags } from '@documenso/lib/client-only/hooks/use-child-route-flags';
import { useOptionalCurrentOrganisation } from '@documenso/lib/client-only/providers/organisation';
import { serializeLastTeamCookie } from '@documenso/lib/revalle/last-team'; // REVALLE:
import { isOrganisationPendingPayment } from '@documenso/lib/utils/billing';
import { TrpcProvider } from '@documenso/trpc/react';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { SubscriptionStatus } from '@prisma/client';
import { useEffect, useMemo } from 'react';
import { Link, Outlet } from 'react-router';

import { GenericErrorLayout } from '~/components/general/generic-error-layout';
import { useOptionalCurrentTeam } from '~/providers/team';

export default function Layout() {
  const team = useOptionalCurrentTeam();
  const organisation = useOptionalCurrentOrganisation();

  const { layoutMode } = useChildRouteFlags();

  const limits = useMemo(() => {
    if (!organisation) {
      return undefined;
    }

    const isRestricted =
      (organisation.subscription && organisation.subscription.status === SubscriptionStatus.INACTIVE) ||
      isOrganisationPendingPayment(organisation);

    if (isRestricted) {
      return {
        quota: {
          documents: 0,
          recipients: 0,
          directTemplates: 0,
        },
        remaining: {
          documents: 0,
          recipients: 0,
          directTemplates: 0,
        },
        maximumEnvelopeItemCount: 0,
      };
    }

    return {
      quota: PAID_PLAN_LIMITS,
      remaining: PAID_PLAN_LIMITS,
      maximumEnvelopeItemCount: DEFAULT_MINIMUM_ENVELOPE_ITEM_COUNT,
    };
  }, [organisation]);

  // REVALLE: guarda o último time aberto (só quando o time existe e é da pessoa), para o "Documentos" do menu fora das
  // páginas de time. No navegador, para não dar ida ao servidor a cada filtro ou página; o menu ainda confere o valor.
  const teamUrl = team?.url;

  useEffect(() => {
    if (teamUrl) {
      // biome-ignore lint/suspicious/noDocumentCookie: cookie simples de primeira parte, sem a Cookie Store API em todo navegador
      document.cookie = serializeLastTeamCookie(teamUrl, { secure: window.location.protocol === 'https:' });
    }
  }, [teamUrl]);

  if (!team) {
    return (
      <GenericErrorLayout
        errorCode={404}
        errorCodeMap={{
          404: {
            heading: msg`Team not found`,
            subHeading: msg`404 Team not found`,
            message: msg`The team you are looking for may have been removed, renamed or may have never existed.`,
          },
        }}
        primaryButton={
          <Button asChild>
            <Link to="/settings/teams">
              <Trans>View teams</Trans>
            </Link>
          </Button>
        }
      ></GenericErrorLayout>
    );
  }

  const trpcHeaders = {
    'x-team-Id': team.id.toString(),
  };

  // Note: We use a key to force a re-render if the team context changes.
  // This is required otherwise you would see the wrong page content.
  return (
    <div key={team.url} className={cn({ 'md:flex md:min-h-0 md:flex-1 md:flex-col': layoutMode === 'settings' })}>
      <TrpcProvider headers={trpcHeaders}>
        <LimitsProvider initialValue={limits} teamId={team.id}>
          <Outlet />
        </LimitsProvider>
      </TrpcProvider>
    </div>
  );
}
