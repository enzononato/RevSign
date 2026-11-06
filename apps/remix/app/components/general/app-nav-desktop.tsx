import { getRootHref } from '@documenso/lib/utils/params';
import { cn } from '@documenso/ui/lib/utils';
import type { HTMLAttributes } from 'react';
import { Link, useParams } from 'react-router';
import { RevsignWordmark } from '~/components/revalle/shell/revsign-wordmark';
import { ShellNavList, ShellSearchButton } from '~/components/revalle/shell/shell-nav';
import { SHELL_GRID_STYLE } from '~/components/revalle/shell/shell-routes';
import { SourceCodeLink } from '~/components/revalle/source-code-link';

import { OrgMenuSwitcher } from './org-menu-switcher';

export type AppNavDesktopProps = HTMLAttributes<HTMLElement> & {
  setIsCommandMenuOpen: (value: boolean) => void;
};

// REVALLE: redesign v3. The top header nav became the fixed 244px blue sidebar (wordmark, search, nav, user card, AGPL).
export const AppNavDesktop = ({ className, setIsCommandMenuOpen, ...props }: AppNavDesktopProps) => {
  const params = useParams();

  return (
    <aside
      className={cn(
        'sticky top-0 hidden h-dvh w-[244px] shrink-0 flex-col gap-[30px] overflow-y-auto bg-shell px-[18px] pt-7 pb-5 text-shell-foreground md:flex',
        className,
      )}
      style={SHELL_GRID_STYLE}
      {...props}
    >
      <div className="flex flex-col gap-5">
        <Link
          to={getRootHref(params)}
          className="self-start rounded-xl px-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <RevsignWordmark variant="onBrand" size="lg" withTagline />
        </Link>

        <ShellSearchButton onClick={() => setIsCommandMenuOpen(true)} />
      </div>

      <ShellNavList />

      <div className="mt-auto flex flex-col gap-[22px]">
        <OrgMenuSwitcher />

        <SourceCodeLink variant="shell" />
      </div>
    </aside>
  );
};
