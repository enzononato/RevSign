import { Trans } from '@lingui/react/macro';

/**
 * Admin → Documentos não selados (Fase 6): NF com todos assinados que espera a aprovação do Financeiro, ou versão
 * substituída por uma troca de conta, não está travada. A marca evita que alguém tente resselar à toa.
 */
export const isRevalleFinanceExpected = (status: string | null) =>
  status === 'PENDING_APPROVAL' || status === 'SUPERSEDED';

export const RevalleUnsealedFinanceBadge = ({ status }: { status: string | null }) => {
  if (status === 'PENDING_APPROVAL') {
    return (
      <span
        className="mt-1 inline-block rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-800 text-xs dark:text-amber-300"
        data-testid="unsealed-finance-held"
      >
        <Trans>Aguardando o Financeiro</Trans>
      </span>
    );
  }

  if (status === 'SUPERSEDED') {
    return (
      <span
        className="mt-1 inline-block rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs"
        data-testid="unsealed-finance-superseded"
      >
        <Trans>Versão substituída</Trans>
      </span>
    );
  }

  return null;
};
