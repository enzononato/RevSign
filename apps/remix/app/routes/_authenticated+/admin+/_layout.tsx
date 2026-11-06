import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { LicenseClient } from '@documenso/lib/server-only/license/license-client';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { cn } from '@documenso/ui/lib/utils';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  AlertTriangleIcon,
  BarChart3,
  Building2Icon,
  Calculator, // REVALLE:
  FileStack,
  LineChartIcon,
  type LucideIcon,
  MailIcon,
  Settings,
  ShieldCheck, // REVALLE:
  Trophy,
  UserCogIcon, // REVALLE:
  Users,
  Wallet2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Outlet, redirect, useLocation } from 'react-router';

import { AdminLicenseStatusBanner } from '~/components/general/admin-license-status-banner';
import { adminMiddleware } from '~/middleware/admin';
import { appMetaTags } from '~/utils/meta';
import type { Route } from './+types/_layout';

export function meta() {
  return appMetaTags(msg`Admin`);
}

export const middleware = [adminMiddleware];

export async function loader({ request }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  const license = await LicenseClient.getInstance()?.getCachedLicense();

  if (!user || !isAdmin(user)) {
    throw redirect('/');
  }

  return {
    license: license || null,
  };
}

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  const { license } = loaderData;
  const { pathname } = useLocation();

  // REVALLE: v3-7a: display H1, nav pills inside a card, content in a white card
  const items: { to: string; icon: LucideIcon; label: ReactNode }[] = [
    { to: '/admin/stats', icon: BarChart3, label: <Trans>Stats</Trans> },
    { to: '/admin/organisations', icon: Building2Icon, label: <Trans>Organisations</Trans> },
    { to: '/admin/claims', icon: Wallet2, label: <Trans>Claims</Trans> },
    { to: '/admin/users', icon: Users, label: <Trans>Users</Trans> },
    { to: '/admin/documents', icon: FileStack, label: <Trans>Documents</Trans> },
    { to: '/admin/unsealed-documents', icon: AlertTriangleIcon, label: <Trans>Unsealed Documents</Trans> },
    { to: '/admin/email-transports', icon: MailIcon, label: <Trans>Email Transports</Trans> },
    { to: '/admin/email-domains', icon: MailIcon, label: <Trans>Email Domains</Trans> },
    { to: '/admin/organisation-insights', icon: Trophy, label: <Trans>Organisation Insights</Trans> },
    { to: '/admin/organisation-stats', icon: LineChartIcon, label: <Trans>Organisation Stats</Trans> },
    { to: '/admin/site-settings', icon: Settings, label: <Trans>Site Settings</Trans> },
    { to: '/admin/revalle-verificacoes', icon: ShieldCheck, label: 'Verificações' },
    { to: '/admin/revalle-contas-contabeis', icon: Calculator, label: 'Contas contábeis' },
    { to: '/admin/revalle-perfis', icon: UserCogIcon, label: 'Perfis' },
  ];

  return (
    <div className="mx-auto w-full max-w-[1260px] px-4 md:px-8">
      <AdminLicenseStatusBanner license={license} />

      <h1 className="font-black font-display text-[28px] tracking-[-0.03em] md:text-4xl">
        <Trans>Admin Panel</Trans>
      </h1>

      <div className="mt-5 grid grid-cols-12 gap-x-6 gap-y-4 md:mt-7">
        <nav
          className={cn(
            'col-span-12 -mx-4 flex gap-2 overflow-x-auto px-4 pb-1',
            'md:sticky md:top-6 md:col-span-3 md:mx-0 md:flex-col md:gap-1 md:self-start md:overflow-visible md:rounded-card md:bg-card md:p-3 md:shadow-card',
          )}
        >
          {items.map((item) => {
            const isActive = pathname?.startsWith(item.to);

            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 font-medium text-sm md:h-10 md:px-3',
                  isActive
                    ? 'bg-accent font-semibold text-brand-text'
                    : 'bg-card text-muted-foreground shadow-card hover:text-foreground md:bg-transparent md:shadow-none md:hover:bg-muted',
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="col-span-12 min-w-0 rounded-card bg-card p-5 shadow-card md:col-span-9 md:p-8">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
