import {
  ACCOUNTING_FILTER_LABELS,
  ACCOUNTING_FILTERS,
  type AccountingFilter,
} from '@documenso/lib/revalle/accounting/accounting-status';
import {
  FINANCE_FILTER_LABELS,
  FINANCE_FILTERS,
  type FinanceFilter,
} from '@documenso/lib/revalle/finance/finance-status';
import {
  INVOICE_LIST_STATUSES,
  type InvoiceListStatus,
  type TInvoiceFilters,
} from '@documenso/lib/revalle/invoice/invoice-filters';
import { cn } from '@documenso/ui/lib/utils';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { Popover, PopoverContent, PopoverTrigger } from '@documenso/ui/primitives/popover';
import { Trans, useLingui } from '@lingui/react/macro';
import { SearchIcon } from 'lucide-react';

import { FilterButtonBox, FilterSelectBox } from './invoice-filter-box';

export type InvoiceFilterBarProps = {
  /** Filtros como estão na URL (sem o padrão da fila). */
  urlFilters: TInvoiceFilters;
  /** Filtros que valem na busca (com o padrão da fila de cada perfil). */
  filters: TInvoiceFilters;
  financeFilter: FinanceFilter | undefined;
  accountingFilter: AccountingFilter | undefined;
  isFinance: boolean;
  isAccounting: boolean;
  accountInput: string;
  onAccountInputChange: (value: string) => void;
  setFilter: <K extends keyof TInvoiceFilters>(key: K, value: TInvoiceFilters[K]) => void;
  onClear: () => void;
};

/**
 * Barra de filtros escolhida (prévia `filtro-A`): a busca na linha inteira e, embaixo, uma caixa por filtro; no celular as
 * caixas rolam de lado numa linha só. Os filtros e os parâmetros da URL são os de antes.
 */
export const InvoiceFilterBar = ({
  urlFilters,
  filters,
  financeFilter,
  accountingFilter,
  isFinance,
  isAccounting,
  accountInput,
  onAccountInputChange,
  setFilter,
  onClear,
}: InvoiceFilterBarProps) => {
  const { t } = useLingui();

  const statusLabels: Record<InvoiceListStatus, string> = {
    PENDING: t`Pendente`,
    COMPLETED: t`Concluído`,
    REJECTED: t`Recusado`,
    CANCELLED: t`Cancelado`,
  };

  // Quem é do perfil tem "Todas" como opção explícita (desliga o padrão da fila); os demais, a opção vazia.
  const financeOptions = [
    ...(isFinance ? [] : [{ value: '', label: FINANCE_FILTER_LABELS.todas }]),
    ...FINANCE_FILTERS.filter((value) => isFinance || value !== 'todas').map((value) => ({
      value,
      label: FINANCE_FILTER_LABELS[value],
      short: value === 'pendentes' ? t`Waiting` : undefined,
    })),
  ];

  const accountingOptions = [
    ...(isAccounting ? [] : [{ value: '', label: ACCOUNTING_FILTER_LABELS.todas }]),
    ...ACCOUNTING_FILTERS.filter((value) => isAccounting || value !== 'todas').map((value) => ({
      value,
      label: ACCOUNTING_FILTER_LABELS[value],
      short: value === 'pendentes' ? t`Waiting` : undefined,
    })),
  ];

  const hasUrlFilters = Object.keys(urlFilters).length > 0;
  const isAccountSet = Boolean(urlFilters.accountCode);

  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-testid="invoice-filter-bar">
      <div className="relative">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-3.5 h-[17px] w-[17px] -translate-y-1/2 text-muted-foreground"
          strokeWidth={2.2}
          aria-hidden
        />
        <Input
          id="invoices-account"
          aria-label={t`Conta (número)`}
          className={cn(
            'pl-10',
            isAccountSet && 'border-transparent bg-accent shadow-[inset_0_0_0_2px_hsl(var(--brand-text))]',
          )}
          type="search"
          inputMode="decimal"
          autoComplete="off"
          placeholder={t`Search by account number, e.g. 2.1.03`}
          value={accountInput}
          onChange={(event) => onAccountInputChange(event.target.value)}
        />
      </div>

      <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 py-0.5 [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
        <FilterSelectBox
          id="invoices-finance"
          label={<Trans>Financeiro</Trans>}
          ariaLabel={t`Situação no Financeiro`}
          value={financeFilter ?? (isFinance ? 'todas' : '')}
          options={financeOptions}
          isSet={Boolean(financeFilter && financeFilter !== 'todas')}
          onChange={(value) => setFilter('finance', (value || (isFinance ? 'todas' : undefined)) as FinanceFilter)}
        />

        {/* REVALLE: validação do centro de custo pela Contabilidade (Fase 7) */}
        <FilterSelectBox
          id="invoices-accounting"
          label={<Trans>Contabilidade</Trans>}
          ariaLabel={t`Validação da Contabilidade`}
          value={accountingFilter ?? (isAccounting ? 'todas' : '')}
          options={accountingOptions}
          isSet={Boolean(accountingFilter && accountingFilter !== 'todas')}
          onChange={(value) =>
            setFilter('accounting', (value || (isAccounting ? 'todas' : undefined)) as AccountingFilter)
          }
        />

        <SentDateBox filters={filters} setFilter={setFilter} />

        <FilterSelectBox
          id="invoices-status"
          label={<Trans>Status</Trans>}
          ariaLabel={t`Status`}
          value={filters.status ?? ''}
          options={[
            { value: '', label: t`Todos` },
            ...INVOICE_LIST_STATUSES.map((status) => ({ value: status, label: statusLabels[status] })),
          ]}
          isSet={Boolean(filters.status)}
          onChange={(value) => setFilter('status', (value || undefined) as InvoiceListStatus)}
        />

        {hasUrlFilters && (
          <button
            type="button"
            className="inline-flex h-11 shrink-0 items-center rounded-full px-2 font-bold text-brand-text text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onClear}
          >
            <Trans>Limpar filtros</Trans>
          </button>
        )}
      </div>
    </div>
  );
};

const shortDay = (day: string) => {
  const [, month, date] = day.split('-');

  return `${date}/${month}`;
};

const SentDateBox = ({ filters, setFilter }: Pick<InvoiceFilterBarProps, 'filters' | 'setFilter'>) => {
  const { t } = useLingui();
  const { from, to } = filters;

  const fromDay = from ? shortDay(from) : '';
  const toDay = to ? shortDay(to) : '';
  const value = from && to ? `${fromDay} – ${toDay}` : from ? t`from ${fromDay}` : to ? t`until ${toDay}` : t`Any date`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <FilterButtonBox label={<Trans>Sent date</Trans>} value={value} isSet={Boolean(from || to)} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(20rem,calc(100vw-2rem))] space-y-3">
        <div className="space-y-1">
          <Label htmlFor="invoices-from">
            <Trans>Enviadas de</Trans>
          </Label>
          <Input
            id="invoices-from"
            type="date"
            value={from ?? ''}
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
            value={to ?? ''}
            onChange={(event) => setFilter('to', event.target.value || undefined)}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
};
