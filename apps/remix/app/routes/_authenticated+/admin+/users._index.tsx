import { findHrInactivatedUsers } from '@documenso/lib/server-only/revalle/users/user-status'; // REVALLE:
import { findUsers } from '@documenso/lib/server-only/user/get-all-users';
import { Trans } from '@lingui/react/macro';

import { AdminUserCreateDialog } from '~/components/dialogs/admin-user-create-dialog';
import { HrInactivatedFilter, ReactivateUserButton } from '~/components/revalle/admin-users/hr-inactivation'; // REVALLE:
import { AdminDashboardUsersTable } from '~/components/tables/admin-dashboard-users-table';

import type { Route } from './+types/users._index';

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);

  const page = Number(url.searchParams.get('page')) || 1;
  const perPage = Number(url.searchParams.get('perPage')) || 10;
  const search = url.searchParams.get('search') || '';

  // REVALLE (v.26): filtro "Inativados pela folha" (?folha=1).
  const hrInactivated = url.searchParams.get('folha') === '1';

  const [{ users, totalPages }] = await Promise.all([
    hrInactivated
      ? findHrInactivatedUsers({ search, page, perPage })
      : findUsers({ username: search, email: search, page, perPage }),
  ]);

  return {
    users,
    totalPages,
    page,
    perPage,
    hrInactivated, // REVALLE:
  };
}

export default function AdminManageUsersPage({ loaderData }: Route.ComponentProps) {
  const { users, totalPages, page, perPage, hrInactivated } = loaderData; // REVALLE: hrInactivated

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="font-black font-display text-[26px] leading-tight tracking-[-0.03em]">
          <Trans>Manage users</Trans>
        </h2>

        <AdminUserCreateDialog />
      </div>

      {/* REVALLE (v.26): filtro "Inativados pela folha" e o "Reativar" de cada linha filtrada. */}
      <HrInactivatedFilter active={hrInactivated} />

      <AdminDashboardUsersTable
        users={users}
        totalPages={totalPages}
        page={page}
        perPage={perPage}
        rowAction={hrInactivated ? (user) => <ReactivateUserButton userId={user.id} /> : undefined}
      />
    </div>
  );
}
