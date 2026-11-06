import { cn } from '@documenso/ui/lib/utils';
import type { ReactNode } from 'react';

/**
 * REVALLE v3: peças comuns dos cartões da nota fiscal (página da NF e página do documento): o cartão macio, a linha
 * "rótulo à esquerda, valor à direita", o código azul antes do nome e a pílula de situação (verde, âmbar, vermelho ou
 * neutra; situação nunca é azul).
 */

export const InvoiceCard = ({
  title,
  children,
  tone = 'default',
  className,
  testId,
}: {
  title?: ReactNode;
  children: ReactNode;
  tone?: 'default' | 'warning';
  className?: string;
  testId?: string;
}) => (
  <section
    className={cn(
      'flex min-w-0 flex-col gap-3 rounded-card p-5 text-foreground text-sm',
      tone === 'warning' ? 'bg-warning-bg' : 'bg-card shadow-card dark:shadow-[0_0_0_1px_hsl(var(--border))]',
      className,
    )}
    data-testid={testId}
  >
    {title && <h2 className="font-display font-extrabold text-[17px] leading-tight">{title}</h2>}
    {children}
  </section>
);

export const InvoiceRows = ({ children, className }: { children: ReactNode; className?: string }) => (
  <dl className={cn('flex flex-col', className)}>{children}</dl>
);

export const InvoiceRow = ({
  label,
  children,
  stacked,
  testId,
}: {
  label: ReactNode;
  children: ReactNode;
  /** Valor longo (motivo, sugestão da IA): embaixo do rótulo, alinhado à esquerda. */
  stacked?: boolean;
  testId?: string;
}) => (
  <div
    className={cn(
      'border-border border-b py-2.5 last:border-0',
      stacked ? 'flex flex-col gap-0.5' : 'flex items-baseline justify-between gap-4',
    )}
  >
    <dt className="shrink-0 text-muted-foreground">{label}</dt>
    <dd
      className={cn('min-w-0 break-words font-semibold text-[14.5px]', !stacked && 'text-right')}
      data-testid={testId}
    >
      {children}
    </dd>
  </div>
);

export const InvoiceCode = ({ code, name }: { code: string; name?: string | null }) => (
  <>
    <span className="mr-1.5 font-display font-extrabold text-[13.5px] text-brand-text">{code}</span>
    {name}
  </>
);

/** "101 – Puxada" → código e nome (o rótulo vem pronto do servidor). */
export const splitCodeLabel = (label: string) => {
  const index = label.indexOf(' – ');

  if (index < 0) {
    return { code: label, name: null };
  }

  return { code: label.slice(0, index), name: label.slice(index + 3) };
};

export type InvoiceTone = 'success' | 'warning' | 'danger' | 'neutral';

export const InvoiceStatePill = ({
  tone,
  children,
  testId,
  className,
}: {
  tone: InvoiceTone;
  children: ReactNode;
  testId?: string;
  className?: string;
}) => (
  <span
    className={cn(
      'inline-flex min-h-7 w-fit items-center rounded-full px-2.5 py-0.5 font-semibold text-[13px]',
      tone === 'success' && 'bg-success-bg text-success',
      tone === 'warning' && 'bg-warning-bg text-warning-text',
      tone === 'danger' && 'bg-danger-bg text-destructive',
      tone === 'neutral' && 'bg-muted text-muted-foreground',
      className,
    )}
    data-testid={testId}
  >
    {children}
  </span>
);

/** Cor da situação no Financeiro: aguardando = âmbar, aprovada = verde, recusada = vermelho, o resto neutro. */
export const financeTone = (financeStatus: string | null, envelopeStatus: string): InvoiceTone => {
  if (envelopeStatus === 'REJECTED' || envelopeStatus === 'CANCELLED') {
    return financeStatus === 'APPROVED' ? 'success' : 'danger';
  }

  if (financeStatus === 'PENDING_APPROVAL') {
    return 'warning';
  }

  if (financeStatus === 'APPROVED') {
    return 'success';
  }

  return 'neutral';
};
