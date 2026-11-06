import { useUpdateSearchParams } from '@documenso/lib/client-only/hooks/use-update-search-params';
import { useSession } from '@documenso/lib/client-only/providers/session';
import { formatRevalleDateTime } from '@documenso/lib/revalle/date-format';
import { isDocumentCompleted } from '@documenso/lib/utils/document';
import { trpc } from '@documenso/trpc/react';
import type { TFindInboxResponse } from '@documenso/trpc/server/document-router/find-inbox.types';
import { Button } from '@documenso/ui/primitives/button';
import type { DataTableColumnDef } from '@documenso/ui/primitives/data-table';
import { DataTable } from '@documenso/ui/primitives/data-table';
import { DataTablePagination } from '@documenso/ui/primitives/data-table-pagination';
import { TableCell } from '@documenso/ui/primitives/table';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { DocumentStatus as DocumentStatusEnum, RecipientRole, SigningStatus } from '@prisma/client';
import { CheckCircleIcon, DownloadIcon, EyeIcon, Loader, PencilIcon } from 'lucide-react';
import { useQueryStates } from 'nuqs';
import { type ReactNode, useMemo, useTransition } from 'react';
import { match } from 'ts-pattern';

import { inboxSearchParams, resolveInboxStatus } from '~/utils/inbox-search-params';

import { EnvelopeDownloadDialog } from '../dialogs/envelope-download-dialog';
import {
  DOCUMENT_ROW_SLOTS_CLASS_NAME,
  DocumentRowCardBody,
  DocumentRowCardSkeletonBody,
  DocumentRowState,
  documentRowCardTableClassName,
} from './document-row-card';
import { RecipientSignerSlots } from './recipient-signer-slots';

type DocumentsTableRow = TFindInboxResponse['data'][number];

export const InboxTable = () => {
  const { _ } = useLingui();
  const { user } = useSession();

  const [isPending, startTransition] = useTransition();

  const updateSearchParams = useUpdateSearchParams();

  const [findInboxSearchParams] = useQueryStates(inboxSearchParams, {
    history: 'push',
  });

  const status = resolveInboxStatus(findInboxSearchParams.status);
  const query = findInboxSearchParams.query ?? '';

  const { data, isLoading, isLoadingError } = trpc.document.inbox.find.useQuery(
    {
      page: Math.max(findInboxSearchParams.page ?? 1, 1),
      perPage: Math.min(Math.max(findInboxSearchParams.perPage ?? 10, 1), 100),
      query: query || undefined,
      status,
    },
    {
      placeholderData: (previousData) => previousData,
    },
  );

  const hasSearchQuery = query.trim().length > 0;

  // REVALLE v3 (finish review 1, #1 e #7): cada linha é um cartão no padrão das NF (título; remetente · data em 24h;
  // encaixes; uma pílula de ação ou de situação).
  const columns = useMemo(() => {
    return [
      {
        id: 'document',
        header: () => _(msg`Document`),
        cell: ({ row }) => (
          <DocumentRowCardBody
            title={<span title={row.original.title}>{row.original.title}</span>}
            meta={`${row.original.user.name ?? row.original.user.email} · ${formatRevalleDateTime(row.original.createdAt)}`}
            slots={
              <RecipientSignerSlots
                recipients={row.original.recipients}
                documentStatus={row.original.status}
                currentUserEmail={user.email}
                max={3}
                withStatusSummary
                className={DOCUMENT_ROW_SLOTS_CLASS_NAME}
              />
            }
            action={
              <InboxTableActionButton
                row={row.original}
                fallback={<DocumentRowState status={row.original.status} recipients={row.original.recipients} />}
              />
            }
          />
        ),
      },
    ] satisfies DataTableColumnDef<DocumentsTableRow>[];
  }, [user.email]);

  const onPaginationChange = (page: number, perPage: number) => {
    startTransition(() => {
      updateSearchParams({
        page,
        perPage,
      });
    });
  };

  // REVALLE v3: frase simples, sem o cinza apagado (legível no claro e no escuro)
  const emptyState = (
    <div className="flex h-48 flex-col items-center justify-center gap-y-4 text-muted-foreground">
      <p>
        {match({ hasSearchQuery, status })
          .with({ hasSearchQuery: true }, () => <Trans>No documents match your search</Trans>)
          .with({ status: DocumentStatusEnum.COMPLETED }, () => (
            <Trans>Documents that you have completed will appear here</Trans>
          ))
          .with({ status: DocumentStatusEnum.REJECTED }, () => (
            <Trans>Documents that have been rejected will appear here</Trans>
          ))
          .with({ status: DocumentStatusEnum.CANCELLED }, () => (
            <Trans>Documents that have been cancelled will appear here</Trans>
          ))
          .otherwise(() => (
            <Trans>Documents that require your attention will appear here</Trans>
          ))}
      </p>
    </div>
  );

  const results = data ?? {
    data: [],
    perPage: 10,
    currentPage: 1,
    totalPages: 1,
  };

  return (
    <div className="relative">
      <DataTable
        columns={columns}
        data={results.data}
        perPage={results.perPage}
        currentPage={results.currentPage}
        totalPages={results.totalPages}
        onPaginationChange={onPaginationChange}
        error={{
          enable: isLoadingError || false,
        }}
        className={documentRowCardTableClassName({ withHeader: false })}
        emptyState={emptyState}
        skeleton={{
          enable: isLoading || false,
          rows: 5,
          component: (
            <TableCell>
              <DocumentRowCardSkeletonBody />
            </TableCell>
          ),
        }}
      >
        {(table) =>
          results.totalPages > 1 && <DataTablePagination additionalInformation="VisibleCount" table={table} />
        }
      </DataTable>

      {isPending && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50">
          <Loader className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
};

export type InboxTableActionButtonProps = {
  row: TFindInboxResponse['data'][number];
  /** REVALLE v3: o que mostrar quando a linha não tem ação para você (a pílula de situação do cartão). */
  fallback?: ReactNode;
};

export const InboxTableActionButton = ({ row, fallback = null }: InboxTableActionButtonProps) => {
  const { user } = useSession();
  const { toast } = useToast();
  const { _ } = useLingui();

  const recipient = row.recipients.find((recipient) => recipient.email === user.email);

  const isPending = row.status === DocumentStatusEnum.PENDING;
  const isComplete = isDocumentCompleted(row.status);
  const isSigned = recipient?.signingStatus === SigningStatus.SIGNED;
  const role = recipient?.role;

  if (!recipient) {
    return fallback;
  }

  // TODO: Consider if want to keep this logic for hiding viewing for CC'ers
  if (recipient?.role === RecipientRole.CC && isComplete === false) {
    return fallback;
  }

  // REVALLE: depois de assinar, o botão "View" continua ativo e abre a página de conclusão (que tem "Ver documento")
  return (
    match({
      isPending,
      isComplete,
      isSigned,
      internalVersion: row.internalVersion,
    })
      .with({ isPending: true, isSigned: false }, () => (
        <Button className="min-w-[8rem]" asChild>
          <a href={`/sign/${recipient?.token}`}>
            {match(role)
              .with(RecipientRole.SIGNER, () => (
                <>
                  <PencilIcon className="mr-2 -ml-1 h-4 w-4" />
                  <Trans>Sign</Trans>
                </>
              ))
              .with(RecipientRole.APPROVER, () => (
                <>
                  <CheckCircleIcon className="mr-2 -ml-1 h-4 w-4" />
                  <Trans>Approve</Trans>
                </>
              ))
              .otherwise(() => (
                <>
                  <EyeIcon className="mr-2 -ml-1 h-4 w-4" />
                  <Trans>View</Trans>
                </>
              ))}
          </a>
        </Button>
      ))
      // REVALLE v3: só "Assinar"/"Aprovar" é azul; ver e baixar ficam em contorno
      .with({ isPending: true, isSigned: true }, () => (
        <Button variant="outline" className="min-w-[8rem]" asChild>
          <a href={`/sign/${recipient.token}`}>
            <EyeIcon className="mr-2 -ml-1 h-4 w-4" />
            <Trans>View</Trans>
          </a>
        </Button>
      ))
      .with({ isComplete: true }, () => (
        <EnvelopeDownloadDialog
          envelopeId={row.envelopeId}
          envelopeStatus={row.status}
          token={recipient?.token}
          trigger={
            <Button variant="outline" className="min-w-[8rem]">
              <DownloadIcon className="mr-2 -ml-1 inline h-4 w-4" />
              <Trans>Download</Trans>
            </Button>
          }
        />
      ))
      .otherwise(() => fallback)
  );
};
