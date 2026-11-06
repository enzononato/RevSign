import { useSession } from '@documenso/lib/client-only/providers/session';
import { type AccountingFilter, invoicesDefaultFilters } from '@documenso/lib/revalle/accounting/accounting-status'; // REVALLE:
import type { FinanceFilter } from '@documenso/lib/revalle/finance/finance-status';
import { formatInvoiceDataLine } from '@documenso/lib/revalle/invoice/invoice-data'; // REVALLE: Fase 8
import {
  INVOICE_EXPORT_LIMIT_MESSAGE,
  invoiceFiltersError,
  invoiceFiltersToParams,
  isOverInvoiceExportLimit,
  readInvoiceFilterParams,
  type TInvoiceFilters,
} from '@documenso/lib/revalle/invoice/invoice-filters';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { msg, plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

// REVALLE (redesign v3): a lista virou cartões, com a barra de filtros e a coluna das filas em componentes próprios.
import { InvoiceFilterBar } from '~/components/revalle/invoice/list/invoice-filter-bar';
import { type InvoiceQueueKind, InvoiceQueues } from '~/components/revalle/invoice/list/invoice-queues';
import { InvoiceRowCard } from '~/components/revalle/invoice/list/invoice-row-card';
import { appMetaTags } from '~/utils/meta';

const PER_PAGE = 20;
const PAGE_PARAM = 'pagina';

export function meta() {
  return appMetaTags(msg`Notas fiscais`);
}

export default function InvoicesPage() {
  const { t } = useLingui();
  const { user, organisations } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();

  const urlFilters = useMemo(() => readInvoiceFilterParams(searchParams), [searchParams]);
  const page = Math.max(1, Number.parseInt(searchParams.get(PAGE_PARAM) ?? '1', 10) || 1);
  const hasFilters = Object.keys(urlFilters).length > 0;

  // Fase 6: quem é do Financeiro vê todas as NFs (o servidor decide) e, sem filtro na URL, começa em "Aguardando o
  // Financeiro". "Todas" desliga esse padrão.
  const { data: financeProfile, isPending: isLoadingFinanceProfile } = trpc.revalle.finance.me.useQuery();
  const isFinance = financeProfile?.isFinance === true;

  // Fase 7: a Contabilidade também vê todas as NFs (o servidor decide) e, sendo só da Contabilidade, abre em "Aguardando a
  // Contabilidade". Quem é dos dois perfis abre na fila do Financeiro.
  const { data: accountingProfile, isPending: isLoadingAccountingProfile } = trpc.revalle.accounting.me.useQuery();
  const isAccounting = accountingProfile?.isMember === true;
  const isLoadingProfile = isLoadingFinanceProfile || isLoadingAccountingProfile;

  // O padrão só vale sem nenhum filtro de fila na URL: escolher uma das filas (ou "Todas" em qualquer uma) desliga o outro.
  const defaults = invoicesDefaultFilters({ isFinance, isAccounting });
  const isDefaultActive = !urlFilters.finance && !urlFilters.accounting;
  const financeFilter: FinanceFilter | undefined =
    urlFilters.finance ?? (isDefaultActive ? defaults.financeiro : undefined);
  const accountingFilter: AccountingFilter | undefined =
    urlFilters.accounting ?? (isDefaultActive ? defaults.contabilidade : undefined);

  const filters = useMemo(() => {
    const effective = { ...urlFilters };

    delete effective.finance;
    delete effective.accounting;

    if (financeFilter && financeFilter !== 'todas') {
      effective.finance = financeFilter;
    }

    if (accountingFilter && accountingFilter !== 'todas') {
      effective.accounting = accountingFilter;
    }

    return effective;
  }, [urlFilters, financeFilter, accountingFilter]);

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

    if (value === undefined || value === '') {
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
  // Fase 8: a legenda explica a linha curta de cada nota (no toque não há `title`); só aparece se alguma linha tem os dados.
  const hasInvoiceData = Boolean(data?.data.some((row) => formatInvoiceDataLine(row.invoiceData) !== null));

  // REVALLE (redesign v3): os números das filas são os do contador do menu (mesma consulta, mesmo cache).
  const { data: pendingCounts } = trpc.revalle.invoice.pendingCounts.useQuery(undefined, { refetchInterval: 60_000 });

  const activeQueue: InvoiceQueueKind | null =
    financeFilter === 'pendentes' ? 'finance' : accountingFilter === 'pendentes' ? 'accounting' : null;

  // Escolher uma fila solta a outra (como no filtro); os demais filtros ficam.
  const queueHref = (queue: InvoiceQueueKind) => {
    const next = { ...urlFilters };

    delete next.finance;
    delete next.accounting;

    const params = invoiceFiltersToParams(
      queue === 'finance' ? { ...next, finance: 'pendentes' } : { ...next, accounting: 'pendentes' },
    );

    return `/notas-fiscais?${params.toString()}`;
  };

  // O envio de documentos fica na página "Documentos" do time pessoal (a NF é reconhecida no envio).
  const teamUrl = organisations.flatMap((organisation) => organisation.teams)[0]?.url ?? null;
  const sendHref = teamUrl ? `/t/${teamUrl}/documents` : null;

  const exportBlockedMessage = dateError
    ? t`A data inicial é depois da data final.`
    : isOverLimit
      ? INVOICE_EXPORT_LIMIT_MESSAGE
      : null;

  const viewer = { isFinance, isAccounting };

  // A fila escolhida pela coluna "Suas filas" vai para a URL; sozinha, ainda conta como "fila vazia" e não "filtro sem nota".
  const isOnlyQueueFilter = Object.keys(urlFilters).every(
    (key) => (activeQueue === 'finance' && key === 'finance') || (activeQueue === 'accounting' && key === 'accounting'),
  );

  const queueProps = {
    counts: pendingCounts,
    activeQueue,
    queueHref,
    sendHref,
    exportHref,
    exportBlockedMessage,
  };

  return (
    <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 md:px-8" data-testid="invoices-page">
      <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_316px] xl:items-start xl:gap-7">
        <section className="min-w-0">
          <h1 className="font-black font-display text-[30px] leading-[1.05] tracking-[-0.03em] md:text-[36px]">
            <Trans>Notas fiscais</Trans>
          </h1>
          <p className="mt-2 text-muted-foreground">
            <WaitingSentence counts={pendingCounts} />
            {isAdmin(user) ? (
              <Trans>Todas as notas fiscais enviadas para assinatura (você é administrador).</Trans>
            ) : isFinance && isAccounting ? (
              <Trans>Todas as notas fiscais enviadas para assinatura (você é do Financeiro e da Contabilidade).</Trans>
            ) : isFinance ? (
              <Trans>Todas as notas fiscais enviadas para assinatura (você é do Financeiro).</Trans>
            ) : isAccounting ? (
              <Trans>Todas as notas fiscais enviadas para assinatura (você é da Contabilidade).</Trans>
            ) : (
              <Trans>As notas fiscais que você enviou ou que chegaram para você assinar.</Trans>
            )}
          </p>

          <InvoiceQueues variant="strip" className="mt-5 xl:hidden" {...queueProps} />

          <div className="mt-5">
            <InvoiceFilterBar
              urlFilters={urlFilters}
              filters={filters}
              financeFilter={financeFilter}
              accountingFilter={accountingFilter}
              isFinance={isFinance}
              isAccounting={isAccounting}
              accountInput={accountInput}
              onAccountInputChange={setAccountInput}
              setFilter={setFilter}
              onClear={() => {
                setAccountInput('');
                applyFilters({});
              }}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="font-semibold text-muted-foreground text-sm">
              {data && (count === 1 ? <Trans>1 nota fiscal</Trans> : <Trans>{count} notas fiscais</Trans>)}
            </p>
            {hasInvoiceData && (
              <p className="text-muted-foreground text-xs" data-testid="invoice-data-legend">
                <Trans>Fornecedor, número e valor: lidos pela IA, confira no PDF.</Trans>
              </p>
            )}
          </div>

          {dateError && (
            <p className="mt-3 text-destructive text-sm" role="alert">
              <Trans>A data inicial é depois da data final.</Trans>
            </p>
          )}

          <div className="mt-3 flex flex-col gap-2.5" data-testid="invoice-list">
            {data?.data.map((row) => (
              <InvoiceRowCard key={row.id} row={row} viewer={viewer} />
            ))}

            {data && data.data.length === 0 && (
              <EmptyState>
                {activeQueue === 'finance' && isOnlyQueueFilter ? (
                  <>
                    <p>
                      <Trans>Nenhuma nota fiscal aguardando o Financeiro.</Trans>
                    </p>
                    <Button variant="outline" onClick={() => setFilter('finance', 'todas')}>
                      <Trans>See all invoices</Trans>
                    </Button>
                  </>
                ) : activeQueue === 'accounting' && isOnlyQueueFilter ? (
                  <>
                    <p>
                      <Trans>Nenhuma nota fiscal aguardando a Contabilidade.</Trans>
                    </p>
                    <Button variant="outline" onClick={() => setFilter('accounting', 'todas')}>
                      <Trans>See all invoices</Trans>
                    </Button>
                  </>
                ) : hasFilters ? (
                  <>
                    <p>
                      <Trans>Nenhuma nota fiscal com esses filtros.</Trans>
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setAccountInput('');
                        applyFilters({});
                      }}
                    >
                      <Trans>Limpar filtros</Trans>
                    </Button>
                  </>
                ) : (
                  <>
                    <p>
                      <Trans>
                        Nenhuma nota fiscal ainda. As notas fiscais que você enviar ou assinar aparecem aqui.
                      </Trans>
                    </p>
                    {sendHref && (
                      <Button asChild>
                        <Link to={sendHref}>
                          <Trans>Send an invoice</Trans>
                        </Link>
                      </Button>
                    )}
                  </>
                )}
              </EmptyState>
            )}

            {!data && !dateError && (
              <EmptyState>
                <p>
                  {isError && !isPending ? (
                    <Trans>Não foi possível carregar as notas fiscais. Tente de novo.</Trans>
                  ) : (
                    <Trans>Carregando…</Trans>
                  )}
                </p>
              </EmptyState>
            )}
          </div>

          {data && data.totalPages > 1 && (
            <nav className="mt-5 flex flex-wrap items-center justify-between gap-3" aria-label={t`Pagination`}>
              <p className="font-semibold text-muted-foreground text-sm">
                <Trans>
                  Página {data.currentPage} de {data.totalPages}
                </Trans>
              </p>
              <div className="flex gap-2">
                <Button variant="outline" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                  <Trans>Anterior</Trans>
                </Button>
                <Button variant="outline" disabled={page >= data.totalPages} onClick={() => goToPage(page + 1)}>
                  <Trans>Próxima</Trans>
                </Button>
              </div>
            </nav>
          )}
        </section>

        <InvoiceQueues variant="card" className="hidden xl:sticky xl:top-6 xl:flex" {...queueProps} />
      </div>
    </div>
  );
}

const EmptyState = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-col items-center gap-4 rounded-card bg-card px-6 py-10 text-center text-muted-foreground shadow-card">
    {children}
  </div>
);

/** Quantas notas esperam a pessoa, antes da frase de quem vê o quê; nada para quem não tem perfil. */
const WaitingSentence = ({ counts }: { counts: { finance: number | null; accounting: number | null } | undefined }) => {
  const { t } = useLingui();

  if (!counts || (counts.finance === null && counts.accounting === null)) {
    return null;
  }

  const { finance, accounting } = counts;

  // Com os dois perfis, uma nota pode esperar as duas filas: somar contaria duas vezes.
  if (finance !== null && accounting !== null) {
    return (
      <>
        <Trans>
          {finance} waiting for Financeiro and {accounting} waiting for Contabilidade.
        </Trans>{' '}
      </>
    );
  }

  const waiting = finance ?? accounting ?? 0;

  if (waiting === 0) {
    return (
      <>
        <Trans>No invoice is waiting for you.</Trans>{' '}
      </>
    );
  }

  return (
    <>{t`${plural(waiting, { one: '# invoice is waiting for you.', other: '# invoices are waiting for you.' })}`} </>
  );
};
