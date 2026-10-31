import { useSession } from '@documenso/lib/client-only/providers/session';
import { formatRevalleDateTime } from '@documenso/lib/revalle/date-format';
import {
  FINANCE_DEFAULT_FILTER,
  FINANCE_FILTER_LABELS,
  FINANCE_FILTERS,
  type FinanceFilter,
  financeStatusLabel,
} from '@documenso/lib/revalle/finance/finance-status';
import {
  INVOICE_EXPORT_LIMIT_MESSAGE,
  INVOICE_LIST_STATUSES,
  type InvoiceListStatus,
  invoiceFiltersError,
  invoiceFiltersToParams,
  isOverInvoiceExportLimit,
  readInvoiceFilterParams,
  type TInvoiceFilters,
} from '@documenso/lib/revalle/invoice/invoice-filters';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { trpc } from '@documenso/trpc/react';
import type { TFindInvoicesResponse } from '@documenso/trpc/server/revalle-router/invoice/find.types';
import { Button } from '@documenso/ui/primitives/button';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@documenso/ui/primitives/table';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { DownloadIcon, ReceiptTextIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { DocumentStatus } from '~/components/general/document/document-status';
import { appMetaTags } from '~/utils/meta';

const PER_PAGE = 20;
const PAGE_PARAM = 'pagina';

const FIELD_CLASS =
  'flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:text-sm';

type InvoiceRow = TFindInvoicesResponse['data'][number];

export function meta() {
  return appMetaTags(msg`Notas fiscais`);
}

export default function InvoicesPage() {
  const { t } = useLingui();
  const { user } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();

  const urlFilters = useMemo(() => readInvoiceFilterParams(searchParams), [searchParams]);
  const page = Math.max(1, Number.parseInt(searchParams.get(PAGE_PARAM) ?? '1', 10) || 1);
  const hasFilters = Object.keys(urlFilters).length > 0;

  // Fase 6: quem é do Financeiro vê todas as NFs (o servidor decide) e, sem filtro na URL, começa em "Aguardando o
  // Financeiro". "Todas" desliga esse padrão.
  const { data: financeProfile, isPending: isLoadingProfile } = trpc.revalle.finance.me.useQuery();
  const isFinance = financeProfile?.isFinance === true;

  const filters = useMemo(() => {
    const effective = { ...urlFilters };

    if (!effective.finance && isFinance) {
      effective.finance = FINANCE_DEFAULT_FILTER;
    }

    if (effective.finance === 'todas') {
      delete effective.finance;
    }

    return effective;
  }, [urlFilters, isFinance]);

  const [accountInput, setAccountInput] = useState(urlFilters.accountCode ?? '');

  const dateError = invoiceFiltersError(filters);

  const query = trpc.revalle.invoice.find.useQuery(
    { ...filters, page, perPage: PER_PAGE },
    { placeholderData: (previous) => previous, enabled: dateError === null && !isLoadingProfile },
  );

  const data = dateError ? undefined : query.data;
  const { isPending, isError } = query;

  const applyFilters = (next: TInvoiceFilters) => {
    setSearchParams(invoiceFiltersToParams(next), { replace: true });
  };

  const setFilter = <K extends keyof TInvoiceFilters>(key: K, value: TInvoiceFilters[K]) => {
    const next = { ...urlFilters };

    if (value === undefined || value === '' || value === false) {
      delete next[key];
    } else {
      next[key] = value;
    }

    applyFilters(next);
  };

  // A conta é digitada: aplica depois de uma pausa, para não buscar a cada tecla.
  useEffect(() => {
    const code = accountInput.trim();

    if (code === (urlFilters.accountCode ?? '')) {
      return;
    }

    const timer = setTimeout(() => setFilter('accountCode', code || undefined), 400);

    return () => clearTimeout(timer);
  }, [accountInput]);

  const goToPage = (next: number) => {
    const params = invoiceFiltersToParams(urlFilters);

    if (next > 1) {
      params.set(PAGE_PARAM, String(next));
    }

    setSearchParams(params);
  };

  const exportQuery = invoiceFiltersToParams(filters).toString();
  const exportHref = `/notas-fiscais/csv${exportQuery ? `?${exportQuery}` : ''}`;
  const count = data?.count ?? 0;
  const isOverLimit = isOverInvoiceExportLimit(count);

  const financeFilter: FinanceFilter | '' = urlFilters.finance ?? (isFinance ? FINANCE_DEFAULT_FILTER : '');

  const statusLabels: Record<InvoiceListStatus, string> = {
    PENDING: t`Pendente`,
    COMPLETED: t`Concluído`,
    REJECTED: t`Recusado`,
    CANCELLED: t`Cancelado`,
  };

  return (
    <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 md:px-8" data-testid="invoices-page">
      <div className="mb-6">
        <h1 className="flex flex-row items-center gap-2 font-bold text-3xl">
          <ReceiptTextIcon className="h-8 w-8 text-muted-foreground" />
          <Trans>Notas fiscais</Trans>
        </h1>
        <p className="mt-1 text-muted-foreground">
          {isAdmin(user) ? (
            <Trans>Todas as notas fiscais enviadas para assinatura (você é administrador).</Trans>
          ) : financeProfile?.isFinance ? (
            <Trans>Todas as notas fiscais enviadas para assinatura (você é do Financeiro).</Trans>
          ) : (
            <Trans>As notas fiscais que você enviou ou que chegaram para você assinar.</Trans>
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="space-y-1">
          <Label htmlFor="invoices-from">
            <Trans>Enviadas de</Trans>
          </Label>
          <Input
            id="invoices-from"
            type="date"
            className="h-11"
            value={filters.from ?? ''}
            onChange={(event) => setFilter('from', event.target.value || undefined)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="invoices-to">
            <Trans>até</Trans>
          </Label>
          <Input
            id="invoices-to"
            type="date"
            className="h-11"
            value={filters.to ?? ''}
            onChange={(event) => setFilter('to', event.target.value || undefined)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="invoices-status">
            <Trans>Status</Trans>
          </Label>
          <select
            id="invoices-status"
            className={FIELD_CLASS}
            value={filters.status ?? ''}
            onChange={(event) => setFilter('status', (event.target.value || undefined) as InvoiceListStatus)}
          >
            <option value="">{t`Todos`}</option>
            {INVOICE_LIST_STATUSES.map((status) => (
              <option key={status} value={status}>
                {statusLabels[status]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="invoices-finance">
            <Trans>Situação no Financeiro</Trans>
          </Label>
          <select
            id="invoices-finance"
            className={FIELD_CLASS}
            value={financeFilter}
            onChange={(event) =>
              setFilter('finance', (event.target.value || (isFinance ? 'todas' : undefined)) as FinanceFilter)
            }
          >
            {!isFinance && <option value="">{FINANCE_FILTER_LABELS.todas}</option>}
            {FINANCE_FILTERS.filter((value) => isFinance || value !== 'todas').map((value) => (
              <option key={value} value={value}>
                {FINANCE_FILTER_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="invoices-account">
            <Trans>Conta (número)</Trans>
          </Label>
          <Input
            id="invoices-account"
            className="h-11"
            inputMode="decimal"
            placeholder={t`Ex.: 2.1.03`}
            value={accountInput}
            onChange={(event) => setAccountInput(event.target.value)}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
        {/* O rótulo inteiro é a área de toque (44 px) da caixa de seleção. */}
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={filters.deferred ?? false}
            onCheckedChange={(checked) => setFilter('deferred', checked === true ? true : undefined)}
          />
          <Trans>Só as deixadas para o Financeiro</Trans>
        </label>

        {hasFilters && (
          <Button
            variant="ghost"
            className="h-11"
            onClick={() => {
              setAccountInput('');
              applyFilters({});
            }}
          >
            <Trans>Limpar filtros</Trans>
          </Button>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          {data && (count === 1 ? <Trans>1 nota fiscal</Trans> : <Trans>{count} notas fiscais</Trans>)}
        </p>

        {dateError ? (
          <p className="text-destructive text-sm" role="alert">
            <Trans>A data inicial é depois da data final.</Trans>
          </p>
        ) : isOverLimit ? (
          <p className="text-destructive text-sm">{INVOICE_EXPORT_LIMIT_MESSAGE}</p>
        ) : (
          <Button asChild variant="outline" className="h-11">
            <a href={exportHref} download>
              <DownloadIcon className="mr-2 h-4 w-4" />
              <Trans>Exportar planilha</Trans>
            </a>
          </Button>
        )}
      </div>

      <div className="mt-4 min-w-0 rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Trans>Título</Trans>
              </TableHead>
              <TableHead>
                <Trans>Remetente</Trans>
              </TableHead>
              <TableHead className="whitespace-nowrap">
                <Trans>Enviado em</Trans>
              </TableHead>
              <TableHead>
                <Trans>Status</Trans>
              </TableHead>
              <TableHead>
                <Trans>Conta</Trans>
              </TableHead>
              <TableHead className="whitespace-nowrap">
                <Trans>Sugestão aceita?</Trans>
              </TableHead>
              <TableHead className="whitespace-nowrap">
                <Trans>Situação no Financeiro</Trans>
              </TableHead>
              <TableHead>
                <Trans>Versão</Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.data.map((row) => (
              <InvoiceTableRow key={row.id} row={row} />
            ))}

            {data && data.data.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                  {filters.finance === FINANCE_DEFAULT_FILTER && !hasFilters ? (
                    <Trans>Nenhuma nota fiscal aguardando o Financeiro.</Trans>
                  ) : hasFilters ? (
                    <Trans>Nenhuma nota fiscal com esses filtros.</Trans>
                  ) : (
                    <Trans>Nenhuma nota fiscal ainda. As notas fiscais que você enviar ou assinar aparecem aqui.</Trans>
                  )}
                </TableCell>
              </TableRow>
            )}

            {!data && !dateError && (
              <TableRow>
                <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                  {isError && !isPending ? (
                    <Trans>Não foi possível carregar as notas fiscais. Tente de novo.</Trans>
                  ) : (
                    <Trans>Carregando…</Trans>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {data && data.totalPages > 1 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-sm">
            <Trans>
              Página {data.currentPage} de {data.totalPages}
            </Trans>
          </p>
          <div className="flex gap-2">
            <Button variant="outline" className="h-11" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
              <Trans>Anterior</Trans>
            </Button>
            <Button
              variant="outline"
              className="h-11"
              disabled={page >= data.totalPages}
              onClick={() => goToPage(page + 1)}
            >
              <Trans>Próxima</Trans>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const InvoiceTableRow = ({ row }: { row: InvoiceRow }) => {
  const account = row.deferred ? (
    row.financeStatus === 'LEGACY' ? (
      <Trans>A definir pela contabilidade</Trans>
    ) : (
      <Trans>A definir pelo Financeiro</Trans>
    )
  ) : row.account ? (
    <span>
      <span className="font-mono">{row.account.code}</span>
      {row.account.name ? ` · ${row.account.name}` : ''}
    </span>
  ) : (
    '-'
  );

  const accepted =
    row.acceptedSuggestion === null ? (
      <span className="text-muted-foreground">
        <Trans>sem sugestão</Trans>
      </span>
    ) : row.acceptedSuggestion ? (
      <Trans>Sim</Trans>
    ) : (
      <Trans>Não</Trans>
    );

  return (
    <TableRow>
      <TableCell className="min-w-[10rem] max-w-[20rem] font-medium">
        {row.link ? (
          <Link to={row.link} className="break-words hover:underline">
            {row.title}
          </Link>
        ) : (
          <span className="break-words">{row.title}</span>
        )}
      </TableCell>
      <TableCell className="min-w-[8rem]">{row.senderName}</TableCell>
      <TableCell className="whitespace-nowrap">
        {row.sentAt ? (
          formatRevalleDateTime(row.sentAt)
        ) : (
          <span className="text-muted-foreground">
            <Trans>não enviada</Trans>
          </span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <DocumentStatus status={row.status} />
          {row.deleted && (
            <span className="whitespace-nowrap rounded-full bg-destructive/10 px-2 py-0.5 text-destructive text-xs">
              <Trans>excluído pelo remetente</Trans>
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="min-w-[10rem]">{account}</TableCell>
      <TableCell className="whitespace-nowrap">{accepted}</TableCell>
      <TableCell className="min-w-[9rem]" data-testid="invoice-row-finance">
        {financeStatusLabel(row.financeStatus, row.status) || '-'}
      </TableCell>
      <TableCell className="whitespace-nowrap">{`v${row.version}`}</TableCell>
    </TableRow>
  );
};
