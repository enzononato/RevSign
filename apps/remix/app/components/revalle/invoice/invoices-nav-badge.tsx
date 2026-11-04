import { trpc } from '@documenso/trpc/react';
import { cn } from '@documenso/ui/lib/utils';
import { useLingui } from '@lingui/react/macro';

/**
 * Contador do menu "Notas fiscais": quantas notas esperam a pessoa, somando a fila do Financeiro e a da Contabilidade (quem
 * tem os dois perfis vê a soma). Some quando não há nada esperando ou quando a pessoa não é de nenhum dos perfis. Atualiza
 * a cada minuto, no lugar dos e-mails de aviso que saíram do fluxo.
 */
export const InvoicesNavBadge = ({ className }: { className?: string }) => {
  const { t } = useLingui();

  const { data } = trpc.revalle.invoice.pendingCounts.useQuery(undefined, { refetchInterval: 60_000 });

  const total = (data?.finance ?? 0) + (data?.accounting ?? 0);

  if (total <= 0) {
    return null;
  }

  return (
    <span
      role="img"
      aria-label={total === 1 ? t`1 nota fiscal aguardando você` : t`${total} notas fiscais aguardando você`}
      data-testid="invoices-nav-badge"
      className={cn(
        'inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 font-semibold text-primary-foreground text-xs leading-none',
        className,
      )}
    >
      {total > 99 ? '99+' : total}
    </span>
  );
};
