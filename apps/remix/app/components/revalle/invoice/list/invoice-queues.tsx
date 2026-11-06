import { ACCOUNTING_FILTER_LABELS } from '@documenso/lib/revalle/accounting/accounting-status';
import { FINANCE_FILTER_LABELS } from '@documenso/lib/revalle/finance/finance-status';
import type { TInvoicePendingCountsResponse } from '@documenso/trpc/server/revalle-router/invoice/pending-counts.types';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { Trans, useLingui } from '@lingui/react/macro';
import { DownloadIcon } from 'lucide-react';
import { Link } from 'react-router';

export type InvoiceQueueKind = 'finance' | 'accounting';

export type InvoiceQueuesProps = {
  variant: 'card' | 'strip';
  /** `null` em cada fila que a pessoa não tem (é o que `pendingCounts` devolve). */
  counts: TInvoicePendingCountsResponse | undefined;
  activeQueue: InvoiceQueueKind | null;
  queueHref: (queue: InvoiceQueueKind) => string;
  /** Página dos documentos, onde fica o envio; `null` sem time (o botão some). */
  sendHref: string | null;
  exportHref: string;
  /** Aviso no lugar do botão da planilha (datas trocadas, acima do limite). */
  exportBlockedMessage: string | null;
  className?: string;
};

/**
 * Coluna da direita (no computador) ou faixa acima da lista (no celular): as filas da pessoa, com o número de cada uma
 * e um link que abre a lista nela, e os botões de enviar NF e exportar a planilha.
 */
export const InvoiceQueues = ({
  variant,
  counts,
  activeQueue,
  queueHref,
  sendHref,
  exportHref,
  exportBlockedMessage,
  className,
}: InvoiceQueuesProps) => {
  const { t } = useLingui();

  const queues = [
    ...(counts && counts.finance !== null
      ? [{ kind: 'finance' as const, label: FINANCE_FILTER_LABELS.pendentes, count: counts.finance }]
      : []),
    ...(counts && counts.accounting !== null
      ? [{ kind: 'accounting' as const, label: ACCOUNTING_FILTER_LABELS.pendentes, count: counts.accounting }]
      : []),
  ];

  const actions = (
    <>
      {sendHref && (
        <Button
          asChild
          size={variant === 'card' ? 'lg' : 'default'}
          className={cn('w-full whitespace-nowrap', variant === 'strip' && 'px-3')}
        >
          <Link to={sendHref}>
            <Trans>Send an invoice</Trans>
          </Link>
        </Button>
      )}

      {exportBlockedMessage ? (
        <p className="text-destructive text-sm" role="alert">
          {exportBlockedMessage}
        </p>
      ) : (
        <Button asChild variant="outline" className={cn('w-full whitespace-nowrap', variant === 'strip' && 'px-3')}>
          <a href={exportHref} download>
            {/* Na faixa do celular o ícone não cabe ao lado do texto, nos dois botões lado a lado. */}
            {variant === 'card' && <DownloadIcon className="mr-2 h-4 w-4" aria-hidden />}
            <Trans>Exportar planilha</Trans>
          </a>
        </Button>
      )}
    </>
  );

  if (variant === 'strip') {
    return (
      <div className={cn('flex min-w-0 flex-col gap-3', className)} data-testid="invoice-queues-strip">
        {queues.length > 0 && (
          <nav
            aria-label={t`Your queues`}
            className="-mx-4 flex gap-2 overflow-x-auto px-4 py-0.5 [scrollbar-width:none] md:mx-0 md:px-0"
          >
            {queues.map((queue) => (
              <Link
                key={queue.kind}
                to={queueHref(queue.kind)}
                aria-current={activeQueue === queue.kind ? 'page' : undefined}
                className={cn(
                  'inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-card pr-1.5 pl-4 font-semibold text-sm shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  activeQueue === queue.kind
                    ? 'bg-accent text-brand-text shadow-[inset_0_0_0_2px_hsl(var(--brand-text))]'
                    : 'text-muted-foreground',
                )}
              >
                {queue.label}
                <span className="inline-grid h-8 min-w-8 place-items-center rounded-full bg-background px-2 font-black font-display text-base text-brand-text">
                  {queue.count}
                </span>
              </Link>
            ))}
          </nav>
        )}

        <div className="flex flex-wrap gap-2 [&>*]:flex-1 [&>*]:basis-[150px]">{actions}</div>
      </div>
    );
  }

  return (
    <aside className={cn('flex flex-col gap-3.5', className)} data-testid="invoice-queues">
      {queues.length > 0 && (
        <section className="rounded-[22px] bg-card p-[22px] shadow-card">
          <h2 className="font-display font-extrabold text-[17px] tracking-normal">
            <Trans>Your queues</Trans>
          </h2>
          <ul className="mt-1">
            {queues.map((queue) => (
              <li key={queue.kind} className="border-border border-b last:border-b-0">
                <Link
                  to={queueHref(queue.kind)}
                  aria-current={activeQueue === queue.kind ? 'page' : undefined}
                  className={cn(
                    '-mx-2 flex min-h-11 items-baseline justify-between gap-3 rounded-[10px] px-2 py-[11px] font-semibold hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    activeQueue === queue.kind ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  <span>{queue.label}</span>
                  <span className="font-black font-display text-2xl text-brand-text leading-none">{queue.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {actions}
    </aside>
  );
};
