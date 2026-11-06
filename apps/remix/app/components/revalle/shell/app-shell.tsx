import { cn } from '@documenso/ui/lib/utils';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { AppCommandMenu } from '~/components/general/app-command-menu';
import { Header } from '~/components/general/app-header';
import { AppNavDesktop } from '~/components/general/app-nav-desktop';
import { AppNavMobile } from '~/components/general/app-nav-mobile';

export type AppShellProps = {
  /** Billing, quota, verify email and site banners: drawn at the top of the main column, never over the sidebar. */
  banners: ReactNode;
  /** `layoutMode === 'settings'`: the main column is viewport tall and the settings layout scrolls inside it. */
  isSettingsLayout: boolean;
  children: ReactNode;
};

/**
 * Blue shell of the logged-in app: 244px sidebar on desktop, 60px top bar plus a blue sheet on mobile. One command
 * menu serves the sidebar search pill, the mobile search button and Ctrl+K.
 */
export const AppShell = ({ banners, isSettingsLayout, children }: AppShellProps) => {
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-dvh bg-background md:flex">
      <AppNavDesktop setIsCommandMenuOpen={setIsCommandMenuOpen} />

      <div className={cn('flex min-w-0 flex-1 flex-col', isSettingsLayout && 'md:h-dvh md:overflow-hidden')}>
        <Header onOpenCommandMenu={() => setIsCommandMenuOpen(true)} onOpenMenu={() => setIsMobileMenuOpen(true)} />

        {banners}

        <main
          className={cn(
            isSettingsLayout ? 'md:flex md:min-h-0 md:flex-1 md:flex-col' : 'pt-6 pb-10 md:px-2 md:pt-[34px] md:pb-12',
          )}
        >
          {isSettingsLayout ? children : <div className="mx-auto w-full max-w-[1260px]">{children}</div>}
        </main>
      </div>

      <AppCommandMenu open={isCommandMenuOpen} onOpenChange={setIsCommandMenuOpen} />

      <AppNavMobile isMenuOpen={isMobileMenuOpen} onMenuOpenChange={setIsMobileMenuOpen} />
    </div>
  );
};
