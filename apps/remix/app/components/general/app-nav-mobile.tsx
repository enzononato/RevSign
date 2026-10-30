import { authClient } from '@documenso/auth/client';
import { useOptionalCurrentOrganisation } from '@documenso/lib/client-only/providers/organisation';
import { useSession } from '@documenso/lib/client-only/providers/session';
import { REVALLE_COMPANY_NAME } from '@documenso/lib/revalle/brand';
import { canAccessOrganisationAnalytics, formatOrganisationAnalyticsPath } from '@documenso/lib/utils/organisations';
import { canExecuteTeamAction, formatAnalyticsPath } from '@documenso/lib/utils/teams';
import { trpc } from '@documenso/trpc/react';
import { Sheet, SheetContent } from '@documenso/ui/primitives/sheet';
import { ThemeSwitcher } from '@documenso/ui/primitives/theme-switcher';
import { Trans, useLingui } from '@lingui/react/macro';
import { ReadStatus } from '@prisma/client';
import { useMemo } from 'react';
import { Link } from 'react-router';

import { BrandingLogo } from '~/components/general/branding-logo';
import { useOptionalCurrentTeam } from '~/providers/team';

export type AppNavMobileProps = {
  isMenuOpen: boolean;
  onMenuOpenChange?: (_value: boolean) => void;
};

export const AppNavMobile = ({ isMenuOpen, onMenuOpenChange }: AppNavMobileProps) => {
  const { t } = useLingui();

  const { organisations } = useSession();

  const currentTeam = useOptionalCurrentTeam();
  const currentOrganisation = useOptionalCurrentOrganisation();

  const { data: unreadCountData } = trpc.document.inbox.getCount.useQuery(
    {
      readStatus: ReadStatus.NOT_OPENED,
    },
    {
      // refetchInterval: 30000, // Refetch every 30 seconds
    },
  );

  const handleMenuItemClick = () => {
    onMenuOpenChange?.(false);
  };

  const menuNavigationLinks = useMemo(() => {
    const navigationTeam =
      currentTeam ??
      (organisations.length === 1 && organisations[0].teams.length === 1 ? organisations[0].teams[0] : null);

    if (!navigationTeam) {
      return [
        {
          href: '/inbox',
          text: t`Inbox`,
        },
        { href: '/notas-fiscais', text: t`Notas fiscais` }, // REVALLE:
        ...(currentOrganisation && canAccessOrganisationAnalytics(currentOrganisation.currentOrganisationRole)
          ? [{ href: formatOrganisationAnalyticsPath(currentOrganisation.url), text: t`Analytics` }]
          : []),
        {
          href: '/settings/profile',
          text: t`Settings`,
        },
      ];
    }

    const teamUrl = navigationTeam.url;

    return [
      {
        href: `/t/${teamUrl}/documents`,
        text: t`Documents`,
      },
      {
        href: `/t/${teamUrl}/templates`,
        text: t`Templates`,
      },
      {
        href: '/inbox',
        text: t`Inbox`,
      },
      { href: '/notas-fiscais', text: t`Notas fiscais` }, // REVALLE:
      ...(canExecuteTeamAction('MANAGE_TEAM', navigationTeam.currentTeamRole)
        ? [{ href: formatAnalyticsPath(teamUrl), text: t`Analytics` }]
        : []),
      {
        href: '/settings/profile',
        text: t`Settings`,
      },
    ];
  }, [currentTeam, currentOrganisation, organisations, t]);

  return (
    <Sheet open={isMenuOpen} onOpenChange={onMenuOpenChange}>
      <SheetContent className="flex w-full max-w-[350px] flex-col">
        <Link to="/" onClick={handleMenuItemClick}>
          {/* REVALLE: logo RevSign em SVG (o PNG invertido no tema escuro distorcia as cores da marca) */}
          <BrandingLogo className="h-7 w-auto" />
        </Link>

        <div className="mt-8 flex w-full flex-col items-start gap-y-4">
          {menuNavigationLinks.map(({ href, text }) => (
            <Link
              key={href}
              className="flex items-center gap-2 font-semibold text-2xl text-foreground hover:text-foreground/80"
              to={href}
              onClick={() => handleMenuItemClick()}
            >
              {text}
              {href === '/inbox' && unreadCountData && unreadCountData.count > 0 && (
                <span className="flex h-6 min-w-[1.5rem] items-center justify-center rounded-full bg-primary px-1.5 font-semibold text-primary-foreground text-xs">
                  {unreadCountData.count > 99 ? '99+' : unreadCountData.count}
                </span>
              )}
            </Link>
          ))}

          <button
            className="font-semibold text-2xl text-foreground hover:text-foreground/80"
            onClick={async () => authClient.signOut()}
          >
            <Trans>Sign Out</Trans>
          </button>
        </div>

        <div className="mt-auto flex w-full flex-col space-y-4 self-end">
          <div className="w-fit">
            <ThemeSwitcher />
          </div>

          {/* REVALLE: direitos da Revalle */}
          <p className="text-muted-foreground text-sm">
            © {new Date().getFullYear()} {REVALLE_COMPANY_NAME}
            <br />
            <Trans>All rights reserved.</Trans>
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
};
