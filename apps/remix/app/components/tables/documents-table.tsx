import { useUpdateSearchParams } from '@documenso/lib/client-only/hooks/use-update-search-params';
import { useSession } from '@documenso/lib/client-only/providers/session';
import { formatRevalleDateTime } from '@documenso/lib/revalle/date-format';
import { isDocumentCompleted } from '@documenso/lib/utils/document';
import { findRecipientByEmail } from '@documenso/lib/utils/recipients';
import { formatDocumentsPath } from '@documenso/lib/utils/teams';
import { trpc } from '@documenso/trpc/react';
import type { TFindDocumentsResponse } from '@documenso/trpc/server/document-router/find-documents.types';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import type { DataTableColumnDef, RowSelectionState } from '@documenso/ui/primitives/data-table';
import { DataTable } from '@documenso/ui/primitives/data-table';
import { DataTablePagination } from '@documenso/ui/primitives/data-table-pagination';
import { Skeleton } from '@documenso/ui/primitives/skeleton';
import { TableCell } from '@documenso/ui/primitives/table';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Loader } from 'lucide-react';
import { useMemo, useTransition } from 'react';
import { Link } from 'react-router';
import { match } from 'ts-pattern';

import { InvoiceDocumentTags } from '~/components/revalle/invoice/invoice-document-tags'; // REVALLE:
import { useCurrentTeam } from '~/providers/team';

import {
  DOCUMENT_ROW_SLOTS_CLASS_NAME,
  DocumentRowCardBody,
  DocumentRowCardSelect,
  DocumentRowCardSkeletonBody,
  DocumentRowState,
  documentRowCardTableClassName,
} from './document-row-card';
import { DocumentsTableActionButton } from './documents-table-action-button';
import { DocumentsTableActionDropdown } from './documents-table-action-dropdown';
import { RecipientSignerSlots } from './recipient-signer-slots';

export type DocumentsTableProps = {
  data?: TFindDocumentsResponse;
  isLoading?: boolean;
  isLoadingError?: boolean;
  onMoveDocument?: (envelopeId: string) => void;
  enableSelection?: boolean;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (selection: RowSelectionState) => void;
};

type DocumentsTableRow = TFindDocumentsResponse['data'][number];

export const DocumentsTable = ({
  data,
  isLoading,
  isLoadingError,
  onMoveDocument,
  enableSelection,
  rowSelection,
  onRowSelectionChange,
}: DocumentsTableProps) => {
  const { _ } = useLingui();
  const { user } = useSession();

  const team = useCurrentTeam();
  const [isPending, startTransition] = useTransition();

  const updateSearchParams = useUpdateSearchParams();

  // REVALLE v3 (finish review 1, #1 e #7): cada linha é um cartão no padrão das NF (título; remetente · data em 24h;
  // encaixes; uma pílula de ação ou de situação; menu "…"). A seleção em massa continua numa coluna própria.
  // REVALLE: conta e centro de custo das NFs desta página (uma consulta só, só leitura).
  const envelopeIds = useMemo(() => (data?.data ?? []).map((document) => document.envelopeId), [data]);
  const { data: invoiceTags } = trpc.revalle.invoice.documentTags.useQuery(
    { teamId: team?.id ?? 0, envelopeIds },
    { enabled: Boolean(team?.id) && envelopeIds.length > 0 },
  );
  const invoiceTagsByEnvelope = useMemo(
    () => new Map((invoiceTags ?? []).map((tags) => [tags.envelopeId, tags])),
    [invoiceTags],
  );

  const columns = useMemo(() => {
    const cols: DataTableColumnDef<DocumentsTableRow>[] = [];

    if (enableSelection) {
      cols.push({
        id: 'select',
        header: ({ table }) => (
          <label className="flex h-11 cursor-pointer items-center gap-3.5 text-muted-foreground">
            <Checkbox
              checked={table.getIsAllPageRowsSelected()}
              onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
              aria-label={_(msg`Select all`)}
              onClick={(e) => e.stopPropagation()}
            />
            <span aria-hidden>{_(msg`Select all`)}</span>
          </label>
        ),
        cell: ({ row }) => (
          <DocumentRowCardSelect>
            <Checkbox
              checked={row.getIsSelected()}
              onCheckedChange={(value) => row.toggleSelected(!!value)}
              aria-label={_(msg`Select row`)}
              onClick={(e) => e.stopPropagation()}
            />
          </DocumentRowCardSelect>
        ),
        enableSorting: false,
        enableHiding: false,
        size: 40,
      });
    }

    cols.push({
      id: 'document',
      header: () => <span className="sr-only">{_(msg`Document`)}</span>,
      cell: ({ row }) => {
        const document = row.original;
        const canAct = !document.deletedAt || isDocumentCompleted(document.status);
        const statePill = <DocumentRowState status={document.status} recipients={document.recipients} />;

        return (
          <DocumentRowCardBody
            title={<DataTableTitle row={document} teamUrl={team?.url} teamEmail={team?.teamEmail?.email} />}
            tags={<InvoiceDocumentTags tags={invoiceTagsByEnvelope.get(document.envelopeId)} />}
            meta={`${document.user.name ?? document.user.email} · ${formatRevalleDateTime(document.createdAt)}`}
            slots={
              <RecipientSignerSlots
                recipients={document.recipients}
                documentStatus={document.status}
                currentUserEmail={user.email}
                max={3}
                withStatusSummary
                className={DOCUMENT_ROW_SLOTS_CLASS_NAME}
              />
            }
            action={canAct ? <DocumentsTableActionButton row={document} fallback={statePill} /> : statePill}
            menu={
              canAct && (
                <DocumentsTableActionDropdown
                  row={document}
                  onMoveDocument={onMoveDocument ? () => onMoveDocument(document.envelopeId) : undefined}
                />
              )
            }
          />
        );
      },
    });

    return cols;
  }, [team, onMoveDocument, enableSelection, user.email, invoiceTagsByEnvelope]);

  const onPaginationChange = (page: number, perPage: number) => {
    startTransition(() => {
      updateSearchParams({
        page,
        perPage,
      });
    });
  };

  const results = data ?? {
    data: [],
    perPage: 10,
    currentPage: 1,
    totalPages: 1,
  };

  return (
    <div className="relative">
      <DataTable
        className={documentRowCardTableClassName({ withHeader: Boolean(enableSelection) })}
        columns={columns}
        data={results.data}
        perPage={results.perPage}
        currentPage={results.currentPage}
        totalPages={results.totalPages}
        onPaginationChange={onPaginationChange}
        error={{
          enable: isLoadingError || false,
        }}
        skeleton={{
          enable: isLoading || false,
          rows: 5,
          component: (
            <>
              {enableSelection && (
                <TableCell>
                  <DocumentRowCardSelect>
                    <Skeleton className="h-4 w-4 rounded" />
                  </DocumentRowCardSelect>
                </TableCell>
              )}
              <TableCell>
                <DocumentRowCardSkeletonBody withMenu />
              </TableCell>
            </>
          ),
        }}
        enableRowSelection={enableSelection}
        rowSelection={rowSelection}
        onRowSelectionChange={onRowSelectionChange}
        getRowId={(row) => row.envelopeId}
      >
        {(table) => <DataTablePagination additionalInformation="VisibleCount" table={table} />}
      </DataTable>

      {isPending && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50">
          <Loader className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
};

const TITLE_LINK_CLASS_NAME =
  'rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

type DataTableTitleProps = {
  row: DocumentsTableRow;
  teamUrl: string;
  teamEmail?: string;
};

const DataTableTitle = ({ row, teamUrl, teamEmail }: DataTableTitleProps) => {
  const { user } = useSession();

  const recipient = findRecipientByEmail({
    recipients: row.recipients,
    userEmail: user.email,
    teamEmail,
  });

  const isOwner = row.user.id === user.id;
  const isRecipient = !!recipient;
  const isCurrentTeamDocument = teamUrl && row.team?.url === teamUrl;

  const documentsPath = formatDocumentsPath(teamUrl);
  const formatPath = `${documentsPath}/${row.envelopeId}`;

  // REVALLE v3: o título é a primeira linha do cartão (até 2 linhas, cortadas pelo cartão); o completo fica no `title`.
  return match({
    isOwner,
    isRecipient,
    isCurrentTeamDocument,
  })
    .with({ isOwner: true }, { isCurrentTeamDocument: true }, () => (
      <Link to={formatPath} title={row.title} className={TITLE_LINK_CLASS_NAME}>
        {row.title}
      </Link>
    ))
    .with({ isRecipient: true }, () => (
      <Link to={`/sign/${recipient?.token}`} title={row.title} className={TITLE_LINK_CLASS_NAME}>
        {row.title}
      </Link>
    ))
    .otherwise(() => <span title={row.title}>{row.title}</span>);
};
