import { authClient } from '@documenso/auth/client';
import { REVALLE_COMPANY_NAME } from '@documenso/lib/revalle/brand';
import { Sheet, SheetContent, SheetTitle } from '@documenso/ui/primitives/sheet';
import { ThemeSwitcher } from '@documenso/ui/primitives/theme-switcher';
import { Trans } from '@lingui/react/macro';
import { LogOutIcon } from 'lucide-react';
import { Link } from 'react-router';
import { RevsignWordmark } from '~/components/revalle/shell/revsign-wordmark';
import { ShellNavList } from '~/components/revalle/shell/shell-nav';
import { SHELL_GRID_STYLE } from '~/components/revalle/shell/shell-routes';
import { SourceCodeLink } from '~/components/revalle/source-code-link';

import { OrgMenuSwitcher } from './org-menu-switcher';

export type AppNavMobileProps = {
  isMenuOpen: boolean;
  onMenuOpenChange?: (_value: boolean) => void;
};

// REVALLE: redesign v3. The mobile sheet is the same blue nav as the desktop sidebar, full height. Analytics stays in the
// account menu (user card), as on desktop.
export const AppNavMobile = ({ isMenuOpen, onMenuOpenChange }: AppNavMobileProps) => {
  const handleMenuItemClick = () => {
    onMenuOpenChange?.(false);
  };

  return (
    <Sheet open={isMenuOpen} onOpenChange={onMenuOpenChange}>
      <SheetContent
        className="flex w-full max-w-[320px] flex-col gap-[30px] overflow-y-auto rounded-none border-0 bg-shell px-[18px] pt-7 pb-5 text-shell-foreground [&>button:last-child]:top-5 [&>button:last-child]:right-3 [&>button:last-child]:grid [&>button:last-child]:h-11 [&>button:last-child]:w-11 [&>button:last-child]:place-items-center [&>button:last-child]:rounded-full [&>button:last-child]:bg-white/10 [&>button:last-child]:text-white [&>button:last-child]:opacity-100 [&>button:last-child]:focus:ring-white [&>button:last-child]:focus:ring-offset-shell"
        style={SHELL_GRID_STYLE}
      >
        <SheetTitle className="sr-only">
          <Trans>Menu</Trans>
        </SheetTitle>

        <Link
          to="/"
          onClick={handleMenuItemClick}
          className="self-start rounded-xl px-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <RevsignWordmark variant="onBrand" size="lg" withTagline />
        </Link>

        <ShellNavList onNavigate={handleMenuItemClick} />

        <div className="mt-auto flex flex-col gap-4">
          <OrgMenuSwitcher side="top" contentClassName="z-[62] w-[calc(100vw-2rem)] max-w-[22rem]" />

          <div className="flex items-center justify-between gap-3 px-1">
            {/* The switcher primitive is drawn for the page ground; on the blue it gets a translucent track. */}
            <div className="[&>div]:bg-white/10 [&_button]:text-shell-foreground">
              <ThemeSwitcher />
            </div>

            <button
              type="button"
              className="flex min-h-11 items-center gap-2 rounded-full px-3 font-semibold text-[#D4DEF5] text-[15px] transition-colors duration-150 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              onClick={async () => authClient.signOut()}
            >
              <LogOutIcon className="h-4 w-4" aria-hidden />
              <Trans>Sign Out</Trans>
            </button>
          </div>

          <div className="flex flex-col gap-1">
            <SourceCodeLink variant="shell" />

            {/* REVALLE: direitos da Revalle */}
            <p className="px-2.5 text-[11.5px] text-shell-muted">
              © {new Date().getFullYear()} {REVALLE_COMPANY_NAME}. <Trans>All rights reserved.</Trans>
            </p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};
