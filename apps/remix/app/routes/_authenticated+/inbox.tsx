import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { DocumentSearch } from '~/components/general/document/document-search';
import { OrganisationInvitations } from '~/components/general/organisations/organisation-invitations';
import { DocumentsTableStatusFilter } from '~/components/tables/documents-table-status-filter';
import { InboxTable } from '~/components/tables/inbox-table';
import { INBOX_SELECTABLE_STATUSES } from '~/utils/inbox-search-params';
import { appMetaTags } from '~/utils/meta';

export function meta() {
  return appMetaTags(msg`Personal Inbox`);
}

export default function InboxPage() {
  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 md:px-8">
      {/* REVALLE v3: cabeçalho e barra de filtros no padrão das listas */}
      <div className="mb-6">
        <h1 className="font-black font-display text-[36px] leading-[1.05] tracking-[-0.03em]">
          <Trans>Inbox</Trans>
        </h1>
        <p className="mt-2 text-muted-foreground">
          <Trans>Any documents that you have been invited to will appear here</Trans>
        </p>

        <OrganisationInvitations className="mt-4" />
      </div>

      <div className="mb-6 flex flex-col gap-2">
        <DocumentSearch className="w-full" />

        <div className="flex flex-wrap items-center gap-2">
          <DocumentsTableStatusFilter statuses={INBOX_SELECTABLE_STATUSES} />
        </div>
      </div>

      <InboxTable />
    </div>
  );
}
