import { useSession } from '@documenso/lib/client-only/providers/session';
import { pickDocumentsTeamUrl, readLastTeamCookie } from '@documenso/lib/revalle/last-team';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { trpc } from '@documenso/trpc/react';
import { cn } from '@documenso/ui/lib/utils';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { ReadStatus } from '@prisma/client';
import { SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useRouteLoaderData } from 'react-router';

import { InvoicesNavBadge } from '~/components/revalle/invoice/invoices-nav-badge';
import { useOptionalCurrentTeam } from '~/providers/team';

type ShellNavLink = {
  href: string;
  label: MessageDescriptor;
  isActive: boolean;
  counter?: 'invoices' | 'inbox';
};

const SETTINGS_PATH = /^\/(?:(?:o|t)\/[^/]+\/)?settings(?:\/|$)/;

const startsWithSegment = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

// O cookie não avisa quando muda: o valor é relido a cada renderização do menu (que acompanha a rota).
const subscribeToNothing = () => () => {};

/**
 * Último time aberto (cookie `revalle_last_team`). Na renderização do servidor e na hidratação vem do loader do layout
 * autenticado, para o HTML e a hidratação baterem; depois, do `document.cookie`, que o loader do time atualiza a cada
 * time aberto.
 */
const useLastTeamUrl = () => {
  const layoutData = useRouteLoaderData('routes/_authenticated+/_layout') as
    | { lastTeamUrl?: string | null }
    | undefined;

  return useSyncExternalStore(
    subscribeToNothing,
    () => readLastTeamCookie(document.cookie),
    () => layoutData?.lastTeamUrl ?? null,
  );
};

/**
 * Links of the blue shell, shared by the desktop sidebar and the mobile sheet. "Documentos" shows whenever the person has
 * a team: the current team, else the last team opened, else the first non-personal team, else the personal one.
 */
const useShellNavLinks = (): ShellNavLink[] => {
  const { user, organisations } = useSession();
  const { pathname } = useLocation();

  const currentTeam = useOptionalCurrentTeam();
  const lastTeamUrl = useLastTeamUrl();

  return useMemo(() => {
    const teamUrl = pickDocumentsTeamUrl({ organisations, currentTeamUrl: currentTeam?.url, lastTeamUrl });

    const links: ShellNavLink[] = [];

    if (teamUrl) {
      const href = `/t/${teamUrl}/documents`;

      links.push({ href, label: msg`Documents`, isActive: startsWithSegment(pathname, href) });
    }

    links.push(
      {
        href: '/notas-fiscais',
        label: msg`Notas fiscais`,
        isActive: startsWithSegment(pathname, '/notas-fiscais'),
        counter: 'invoices',
      },
      { href: '/inbox', label: msg`Inbox`, isActive: startsWithSegment(pathname, '/inbox'), counter: 'inbox' },
      { href: '/verificar', label: msg`Verify document`, isActive: false },
      { href: '/settings/profile', label: msg`Settings`, isActive: SETTINGS_PATH.test(pathname) },
    );

    if (isAdmin(user)) {
      links.push({ href: '/admin', label: msg`Admin`, isActive: startsWithSegment(pathname, '/admin') });
    }

    return links;
  }, [currentTeam, lastTeamUrl, organisations, pathname, user]);
};

export type ShellNavListProps = {
  className?: string;
  onNavigate?: () => void;
};

export const ShellNavList = ({ className, onNavigate }: ShellNavListProps) => {
  const { _ } = useLingui();

  const links = useShellNavLinks();

  const { data: unreadCountData } = trpc.document.inbox.getCount.useQuery({
    readStatus: ReadStatus.NOT_OPENED,
  });

  const unreadCount = unreadCountData?.count ?? 0;

  return (
    <nav aria-label={_(msg`Main navigation`)} className={cn('flex flex-col gap-0.5', className)}>
      {links.map(({ href, label, isActive, counter }) => (
        <Link
          key={href}
          to={href}
          onClick={onNavigate}
          aria-current={isActive ? 'page' : undefined}
          className={cn(
            'flex min-h-11 items-center justify-between gap-2 rounded-[14px] px-3 py-[11px] font-semibold text-[15px] leading-snug transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-shell',
            isActive ? 'bg-white text-shell' : 'text-[#D4DEF5] hover:bg-white/10 hover:text-white',
          )}
        >
          <span className="min-w-0 truncate">{_(label)}</span>

          {counter === 'invoices' && <InvoicesNavBadge className="shrink-0" />}

          {counter === 'inbox' && unreadCount > 0 && (
            <span
              className={cn(
                'inline-flex h-6 min-w-[24px] shrink-0 items-center justify-center rounded-full px-[7px] font-display font-extrabold text-[12.5px] tabular-nums leading-none',
                isActive ? 'bg-shell/10 text-shell' : 'bg-white/15 text-white',
              )}
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Link>
      ))}
    </nav>
  );
};

export type ShellSearchButtonProps = {
  className?: string;
  onClick: () => void;
};

export const ShellSearchButton = ({ className, onClick }: ShellSearchButtonProps) => {
  const [modifierKey, setModifierKey] = useState('Ctrl');

  useEffect(() => {
    const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';

    setModifierKey(/Macintosh|Mac\s+OS\s+X/i.test(userAgent) ? '⌘' : 'Ctrl');
  }, []);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-11 w-full items-center gap-2.5 rounded-full bg-white/10 pr-2 pl-4 text-left font-semibold text-[14px] text-shell-muted ring-1 ring-white/15 ring-inset transition-colors duration-150 hover:bg-white/15 hover:text-white',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white',
        className,
      )}
    >
      <SearchIcon className="h-4 w-4 shrink-0" aria-hidden />

      <span className="flex-1">
        <Trans>Search</Trans>
      </span>

      <kbd className="rounded-full bg-white/10 px-2 py-0.5 font-sans font-semibold text-[11.5px] tracking-wide">
        {modifierKey}+K
      </kbd>
    </button>
  );
};
