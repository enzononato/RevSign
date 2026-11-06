import { getRootHref } from '@documenso/lib/utils/params';
import { cn } from '@documenso/ui/lib/utils';
import { Trans } from '@lingui/react/macro';
import { MenuIcon, SearchIcon } from 'lucide-react';
import { type HTMLAttributes, useState } from 'react';
import { Link, useParams } from 'react-router';
import { RevsignWordmark } from '~/components/revalle/shell/revsign-wordmark';
import { SHELL_GRID_STYLE } from '~/components/revalle/shell/shell-routes';

import { AppCommandMenu } from './app-command-menu';
import { AppNavMobile } from './app-nav-mobile';

export type HeaderProps = HTMLAttributes<HTMLElement> & {
  /** Set by AppShell, which owns the command menu and the sheet. Without them the bar is standalone (see below). */
  onOpenCommandMenu?: () => void;
  onOpenMenu?: () => void;
};

const iconButtonClassName =
  'grid h-11 w-11 place-items-center rounded-full text-shell-foreground transition-colors duration-150 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white';

// REVALLE: redesign v3. Inside AppShell this is the mobile top bar only (desktop has the blue sidebar). Pages outside
// the shell (recipient pages and public profile while logged in) render it standalone: the same blue bar at every width,
// with its own command menu and nav sheet.
export const Header = ({ className, onOpenCommandMenu, onOpenMenu, ...props }: HeaderProps) => {
  const params = useParams();

  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const isStandalone = !onOpenCommandMenu || !onOpenMenu;

  const handleOpenCommandMenu = onOpenCommandMenu ?? (() => setIsCommandMenuOpen(true));
  const handleOpenMenu = onOpenMenu ?? (() => setIsMenuOpen(true));

  return (
    <header
      className={cn(
        'sticky top-0 z-[60] flex h-[60px] w-full items-center justify-between gap-3 bg-shell pr-2 pl-4 text-shell-foreground md:pr-4 md:pl-6',
        !isStandalone && 'md:hidden',
        className,
      )}
      style={SHELL_GRID_STYLE}
      data-testid="app-header-container"
      {...props}
    >
      <Link
        to={getRootHref(params)}
        className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <RevsignWordmark variant="onBrand" size="sm" />
      </Link>

      <div className="flex items-center gap-1">
        <button type="button" className={iconButtonClassName} onClick={handleOpenCommandMenu}>
          <SearchIcon className="h-[22px] w-[22px]" aria-hidden />
          <span className="sr-only">
            <Trans>Search</Trans>
          </span>
        </button>

        <button type="button" className={iconButtonClassName} onClick={handleOpenMenu}>
          <MenuIcon className="h-6 w-6" aria-hidden />
          <span className="sr-only">
            <Trans>Menu</Trans>
          </span>
        </button>
      </div>

      {isStandalone && (
        <>
          <AppCommandMenu open={isCommandMenuOpen} onOpenChange={setIsCommandMenuOpen} />

          <AppNavMobile isMenuOpen={isMenuOpen} onMenuOpenChange={setIsMenuOpen} />
        </>
      )}
    </header>
  );
};
