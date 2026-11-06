import { authClient } from '@documenso/auth/client';
import { useOptionalCurrentOrganisation } from '@documenso/lib/client-only/providers/organisation';
import { useSession } from '@documenso/lib/client-only/providers/session';
import { IS_BILLING_ENABLED } from '@documenso/lib/constants/app';
import { EXTENDED_ORGANISATION_MEMBER_ROLE_MAP } from '@documenso/lib/constants/organisations-translations';
import { EXTENDED_TEAM_MEMBER_ROLE_MAP } from '@documenso/lib/constants/teams-translations';
import { formatAvatarUrl } from '@documenso/lib/utils/avatars';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import {
  canAccessOrganisationAnalytics,
  canExecuteOrganisationAction,
  formatOrganisationAnalyticsPath,
} from '@documenso/lib/utils/organisations';
import { extractInitials } from '@documenso/lib/utils/recipient-formatter';
import { canExecuteTeamAction, formatAnalyticsPath } from '@documenso/lib/utils/teams';
import { trpc } from '@documenso/trpc/react';
import { AnimateGenericFadeInOut } from '@documenso/ui/components/animate/animate-generic-fade-in-out';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@documenso/ui/primitives/dropdown-menu';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { Building2Icon, ChevronsUpDown, Plus, Settings2Icon, SettingsIcon, UsersIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router';

import { useOptionalCurrentTeam } from '~/providers/team';

// REVALLE: redesign v3. The trigger is the user card at the bottom of the blue shell; the menu content is upstream.
export type OrgMenuSwitcherProps = {
  /** Where the menu opens: to the right of the card in the desktop sidebar, above it in the mobile sheet. */
  side?: 'right' | 'top';
  contentClassName?: string;
};

export const OrgMenuSwitcher = ({ side = 'right', contentClassName }: OrgMenuSwitcherProps) => {
  const { _ } = useLingui();

  const { user, organisations } = useSession();

  const { pathname } = useLocation();

  const [isOpen, setIsOpen] = useState(false);
  const [hoveredOrgId, setHoveredOrgId] = useState<string | null>(null);

  const isUserAdmin = isAdmin(user);

  const isPathOrgUrl = (orgUrl: string) => {
    if (!pathname || !pathname.startsWith(`/o/`)) {
      return false;
    }

    return pathname.split('/')[2] === orgUrl;
  };

  const selectedOrg = organisations.find((org) => isPathOrgUrl(org.url));
  const hoveredOrg = organisations.find((org) => org.id === hoveredOrgId || organisations.length === 1);

  const currentOrganisation = useOptionalCurrentOrganisation();
  const currentTeam = useOptionalCurrentTeam();

  const canAccessOrganisationSettings =
    currentOrganisation &&
    canExecuteOrganisationAction('MANAGE_ORGANISATION', currentOrganisation.currentOrganisationRole);

  const canAccessTeamSettings = currentTeam && canExecuteTeamAction('MANAGE_TEAM', currentTeam.currentTeamRole);

  // Team analytics take precedence when in a team context, the team page links to organisation analytics.
  const analyticsPath = canAccessTeamSettings
    ? formatAnalyticsPath(currentTeam.url)
    : currentOrganisation && canAccessOrganisationAnalytics(currentOrganisation.currentOrganisationRole)
      ? formatOrganisationAnalyticsPath(currentOrganisation.url)
      : null;

  // Use hovered org for teams display if available,
  // otherwise use current team's org if in a team,
  // finally fallback to selected org
  const displayedOrg = hoveredOrg || currentOrganisation || selectedOrg;

  const formatAvatarFallback = (name?: string) => {
    if (name !== undefined) {
      return name.slice(0, 1).toUpperCase();
    }

    return user.name ? extractInitials(user.name) : user.email.slice(0, 1).toUpperCase();
  };

  const dropdownMenuAvatarText = useMemo(() => {
    if (currentTeam) {
      return {
        avatarSrc: formatAvatarUrl(currentTeam.avatarImageId),
        avatarFallback: formatAvatarFallback(currentTeam.name),
        primaryText: currentTeam.name,
        secondaryText: _(EXTENDED_TEAM_MEMBER_ROLE_MAP[currentTeam.currentTeamRole]),
      };
    }

    if (currentOrganisation) {
      return {
        avatarSrc: formatAvatarUrl(currentOrganisation.avatarImageId),
        avatarFallback: formatAvatarFallback(currentOrganisation.name),
        primaryText: currentOrganisation.name,
        secondaryText: _(EXTENDED_ORGANISATION_MEMBER_ROLE_MAP[currentOrganisation.currentOrganisationRole]),
      };
    }

    return {
      avatarSrc: formatAvatarUrl(user.avatarImageId),
      avatarFallback: formatAvatarFallback(user.name ?? user.email),
      primaryText: user.name,
      secondaryText: _(msg`Personal Account`),
    };
  }, [currentTeam, currentOrganisation, user]);

  // REVALLE: the card's second line is the person's NF profile; the query is the one the sidebar counter already runs.
  const { data: invoiceCounts } = trpc.revalle.invoice.pendingCounts.useQuery(undefined, { refetchInterval: 60_000 });

  const isFinance = invoiceCounts?.finance !== null && invoiceCounts?.finance !== undefined;
  const isAccounting = invoiceCounts?.accounting !== null && invoiceCounts?.accounting !== undefined;

  const userCardName = user.name || user.email;
  const userCardInitials = user.name ? extractInitials(user.name) : user.email.slice(0, 1).toUpperCase();
  const userCardAvatarSrc = formatAvatarUrl(user.avatarImageId);

  const userCardLine =
    isFinance && isAccounting
      ? _(msg`Finance and Accounting`)
      : isFinance
        ? _(msg`Financeiro`)
        : isAccounting
          ? _(msg`Contabilidade`)
          : currentTeam || currentOrganisation
            ? dropdownMenuAvatarText.primaryText
            : dropdownMenuAvatarText.secondaryText;

  const handleOpenChange = (open: boolean) => {
    if (open) {
      setHoveredOrgId(currentOrganisation?.id || null);
    }

    setIsOpen(open);
  };

  return (
    <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        {/* REVALLE: user card (avatar tile, name, profile line) */}
        <button
          type="button"
          data-testid="menu-switcher"
          className="flex w-full min-w-0 items-center gap-[11px] rounded-2xl bg-white/[.09] p-2.5 text-left text-shell-foreground transition-colors duration-150 hover:bg-white/[.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white data-[state=open]:bg-white/[.14]"
        >
          {userCardAvatarSrc ? (
            <img src={userCardAvatarSrc} alt="" className="h-[38px] w-[38px] shrink-0 rounded-xl object-cover" />
          ) : (
            <span
              aria-hidden
              className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-xl bg-white font-display font-extrabold text-[14px] text-shell"
            >
              {userCardInitials}
            </span>
          )}

          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-bold text-[14px] leading-snug">{userCardName}</span>
            <span className="truncate text-[12.5px] text-shell-muted leading-snug">{userCardLine}</span>
          </span>

          <ChevronsUpDown className="h-4 w-4 shrink-0 text-shell-muted" aria-hidden />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className={cn('z-[60] flex w-full divide-x divide-border p-0 md:min-w-[40rem]', contentClassName)}
        side={side}
        align={side === 'right' ? 'end' : 'start'}
        sideOffset={side === 'right' ? 14 : 8}
        forceMount
      >
        <div className="flex h-[400px] w-full divide-x">
          {/* Organisations column */}
          <div className="flex w-full flex-col md:w-1/3">
            <div className="flex h-12 items-center border-b p-2">
              <h3 className="flex items-center px-2 font-medium text-muted-foreground text-sm">
                <Building2Icon className="mr-2 h-3.5 w-3.5" />
                <Trans>Organisations</Trans>
              </h3>
            </div>
            <div className="flex-1 space-y-1 overflow-y-auto p-1.5">
              {organisations.map((org) => (
                <div className="group relative" key={org.id} onMouseEnter={() => setHoveredOrgId(org.id)}>
                  <DropdownMenuItem
                    className={cn(
                      'w-full px-4 py-2 text-muted-foreground',
                      org.id === currentOrganisation?.id && !hoveredOrgId && 'bg-accent',
                      org.id === hoveredOrgId && 'bg-accent',
                    )}
                    asChild
                  >
                    <Link to={`/o/${org.url}`} className="flex items-center space-x-2 pr-8">
                      <span
                        className={cn('min-w-0 flex-1 truncate', {
                          'font-semibold': org.id === selectedOrg?.id,
                        })}
                      >
                        {org.name}
                      </span>
                    </Link>
                  </DropdownMenuItem>

                  {canExecuteOrganisationAction('MANAGE_ORGANISATION', org.currentOrganisationRole) && (
                    <div className="absolute top-0 right-0 bottom-0 flex items-center justify-center">
                      <Link
                        to={`/o/${org.url}/settings/general`}
                        className="mr-2 rounded-sm border p-1 text-muted-foreground transition-opacity duration-200 group-hover:opacity-100 md:opacity-0"
                      >
                        <Settings2Icon className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  )}
                </div>
              ))}

              <Button variant="ghost" className="w-full justify-start" asChild>
                <Link to="/settings/organisations?action=add-organisation">
                  <Plus className="mr-2 h-4 w-4" />
                  <Trans>Create Organisation</Trans>
                </Link>
              </Button>
            </div>
          </div>

          {/* Teams column */}
          <div className="hidden w-1/3 flex-col md:flex">
            <div className="flex h-12 items-center border-b p-2">
              <h3 className="flex items-center px-2 font-medium text-muted-foreground text-sm">
                <UsersIcon className="mr-2 h-3.5 w-3.5" />
                <Trans>Teams</Trans>
              </h3>
            </div>
            <div className="flex-1 space-y-1 overflow-y-auto p-1.5">
              <AnimateGenericFadeInOut key={displayedOrg ? 'displayed-org' : 'no-org'}>
                {hoveredOrg ? (
                  hoveredOrg.teams.map((team) => (
                    <div className="group relative" key={team.id}>
                      <DropdownMenuItem
                        className={cn(
                          'w-full px-4 py-2 text-muted-foreground',
                          team.id === currentTeam?.id && 'bg-accent',
                        )}
                        asChild
                      >
                        <Link to={`/t/${team.url}`} className="flex items-center space-x-2 pr-8">
                          <span
                            className={cn('min-w-0 flex-1 truncate', {
                              'font-semibold': team.id === currentTeam?.id,
                            })}
                          >
                            {team.name}
                          </span>
                        </Link>
                      </DropdownMenuItem>

                      {canExecuteTeamAction('MANAGE_TEAM', team.currentTeamRole) && (
                        <div className="absolute top-0 right-0 bottom-0 flex items-center justify-center">
                          <Link
                            to={`/t/${team.url}/settings/general`}
                            className="mr-2 rounded-sm border p-1 text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                          >
                            <Settings2Icon className="h-3.5 w-3.5" />
                          </Link>
                        </div>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="my-12 flex items-center justify-center px-2 text-center text-muted-foreground text-sm">
                    <Trans>Select an organisation to view teams</Trans>
                  </div>
                )}

                {displayedOrg && (
                  <Button variant="ghost" className="w-full justify-start" asChild>
                    <Link to={`/o/${displayedOrg.url}/settings/teams?action=add-team`}>
                      <Plus className="mr-2 h-4 w-4" />
                      <Trans>Create Team</Trans>
                    </Link>
                  </Button>
                )}
              </AnimateGenericFadeInOut>
            </div>
          </div>

          {/* Settings column */}
          <div className="hidden w-1/3 flex-col md:flex">
            <div className="flex h-12 items-center border-b p-2">
              <h3 className="flex items-center px-2 font-medium text-muted-foreground text-sm">
                <SettingsIcon className="mr-2 h-3.5 w-3.5" />
                <Trans>Settings</Trans>
              </h3>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5">
              {isUserAdmin && (
                <DropdownMenuItem className="px-4 py-2 text-muted-foreground" asChild>
                  <Link to="/admin">
                    <Trans>Admin panel</Trans>
                  </Link>
                </DropdownMenuItem>
              )}

              <DropdownMenuItem className="px-4 py-2 text-muted-foreground" asChild>
                <Link to="/inbox">
                  <Trans>Inbox</Trans>
                </Link>
              </DropdownMenuItem>

              {analyticsPath && (
                <DropdownMenuItem className="px-4 py-2 text-muted-foreground" asChild>
                  <Link to={analyticsPath}>
                    <Trans>Analytics</Trans>
                  </Link>
                </DropdownMenuItem>
              )}

              <DropdownMenuItem className="px-4 py-2 text-muted-foreground" asChild>
                <Link
                  to={
                    canAccessOrganisationSettings
                      ? `/o/${currentOrganisation?.url}/settings/general`
                      : canAccessTeamSettings
                        ? `/t/${currentTeam?.url}/settings/general`
                        : '/settings/profile'
                  }
                >
                  <Trans>Settings</Trans>
                </Link>
              </DropdownMenuItem>

              <DropdownMenuItem className="px-4 py-2 text-muted-foreground" asChild>
                <Link to="/settings/profile">
                  <Trans>Account</Trans>
                </Link>
              </DropdownMenuItem>

              {IS_BILLING_ENABLED() && (
                <DropdownMenuItem className="px-4 py-2 text-muted-foreground" asChild>
                  <Link to="/settings/billing">
                    <Trans>Billing</Trans>
                  </Link>
                </DropdownMenuItem>
              )}

              {/* REVALLE: Idioma e Suporte saem do menu da conta (Fase 7, spec §6). */}
              <DropdownMenuItem
                className="hover:!text-muted-foreground px-4 py-2 text-muted-foreground"
                onSelect={async () => authClient.signOut()}
              >
                <Trans>Sign Out</Trans>
              </DropdownMenuItem>
            </div>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
