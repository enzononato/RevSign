import { accountingStatusLabel } from '@documenso/lib/revalle/accounting/accounting-status';
import { formatRevalleDateTime } from '@documenso/lib/revalle/date-format';
import { financeStatusLabel, invoiceViewPath } from '@documenso/lib/revalle/finance/finance-status';
import { costCenterName } from '@documenso/lib/revalle/invoice/cost-centers';
import { formatInvoiceAmount } from '@documenso/lib/revalle/invoice/invoice-data';
import {
  type InvoiceListViewer,
  type InvoiceRowAction,
  invoiceAiTitle,
  invoiceRowAction,
  invoiceSignerSummary,
  signerFirstName,
} from '@documenso/lib/revalle/invoice/invoice-list-row';
import type { TFindInvoicesResponse } from '@documenso/trpc/server/revalle-router/invoice/find.types';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { Trans, useLingui } from '@lingui/react/macro';
import { CheckIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { type SignerSlot, SignerSlots } from '~/components/revalle/shell/signer-slots';

export type InvoiceRow = TFindInvoicesResponse['data'][number];

export type InvoiceRowCardProps = {
  row: InvoiceRow;
  viewer: InvoiceListViewer;
};

/**
 * Cartão de uma NF na lista (prévia `fusao-desktop`): título e etiquetas, encaixes de quem assina e uma pílula. No
 * cartão estreito (celular) tudo empilha e a pílula ocupa a largura toda.
 */
export const InvoiceRowCard = ({ row, viewer }: InvoiceRowCardProps) => {
  const { t } = useLingui();

  const aiTitle = invoiceAiTitle(row.invoiceData);
  const title = aiTitle ?? row.title;
  const action = invoiceRowAction(row, viewer);
  const financeLabel = financeStatusLabel(row.financeStatus, row.status);
  const sender = row.senderName;
  const sentAtLabel = row.sentAt ? formatRevalleDateTime(row.sentAt) : null;

  const slots: SignerSlot[] = row.recipients.map((recipient) => ({
    name: recipient.name.trim() || recipient.email,
    state:
      recipient.signingStatus === 'SIGNED' ? 'signed' : recipient.signingStatus === 'REJECTED' ? 'rejected' : 'pending',
  }));

  return (
    <article
      className="@container rounded-card bg-card px-4 py-3.5 shadow-card sm:pr-[18px] sm:pl-[22px]"
      data-testid="invoice-row"
    >
      <div className="flex @2xl:grid @2xl:grid-cols-[minmax(0,1fr)_132px_152px] flex-col @2xl:items-center @2xl:gap-[18px] gap-3">
        <div className="min-w-0">
          <h3 className="min-w-0 font-bold font-sans text-base leading-snug tracking-normal">
            {row.link ? (
              <Link
                to={row.link}
                className="block truncate rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={aiTitle ? t`Lidos pela IA, confira no PDF` : undefined}
              >
                {title}
              </Link>
            ) : (
              <span className="block truncate" title={aiTitle ? t`Lidos pela IA, confira no PDF` : undefined}>
                {title}
              </span>
            )}
          </h3>

          {/* REVALLE: as etiquetas quebram linha em vez de cortar o nome da conta (é o que o Financeiro aprova). */}
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {row.account ? (
                <Tag code={row.account.code}>{row.account.name}</Tag>
              ) : (
                <Tag>
                  <Trans>No account</Trans>
                </Tag>
              )}

              <span data-testid="invoice-row-cost-center" className="contents">
                {row.costCenterCode ? (
                  <Tag code={row.costCenterCode}>{costCenterName(row.costCenterCode)}</Tag>
                ) : (
                  <Tag>
                    <Trans>Sem centro de custo</Trans>
                  </Tag>
                )}
              </span>

              {/* REVALLE (Fase 8): só vem verdadeiro para o Financeiro, a Contabilidade e o admin. */}
              {row.isPossibleDuplicate && (
                <span
                  className="inline-flex h-[26px] shrink-0 items-center whitespace-nowrap rounded-full bg-warning-bg px-2.5 font-semibold text-[13px] text-warning-text"
                  title={t`Outra nota enviada tem a mesma chave de acesso ou o mesmo arquivo. Confira antes de aprovar.`}
                  data-testid="invoice-row-duplicate"
                >
                  <Trans>Possível duplicada</Trans>
                </span>
              )}

              {row.deleted && (
                <span className="inline-flex h-[26px] shrink-0 items-center whitespace-nowrap rounded-full bg-danger-bg px-2.5 font-semibold text-[13px] text-destructive">
                  <Trans>excluído pelo remetente</Trans>
                </span>
              )}

              {/* Pendência já aparece na pílula; aqui só o que já foi resolvido. */}
              {row.financeStatus === 'APPROVED' && (
                <DoneTag testId="invoice-row-finance" title={`${t`Situação no Financeiro`}: ${financeLabel}`}>
                  <Trans>Account approved</Trans>
                </DoneTag>
              )}

              {row.costCenterValidatedAt && (
                <DoneTag
                  testId="invoice-row-accounting"
                  title={`${t`Validação da Contabilidade`}: ${accountingStatusLabel(row)}`}
                >
                  <Trans>Cost center validated</Trans>
                </DoneTag>
              )}
            </div>
            {row.invoiceData?.totalAmountCents != null && (
              <span
                className="ml-auto shrink-0 whitespace-nowrap pl-1 font-extrabold text-sm"
                title={t`Lidos pela IA, confira no PDF`}
              >
                {formatInvoiceAmount(row.invoiceData.totalAmountCents)}
              </span>
            )}
          </div>

          <p className="mt-1 flex min-w-0 gap-1 text-[13px] text-muted-foreground">
            <span className="shrink-0 whitespace-nowrap">
              {sentAtLabel ? (
                <Trans>
                  Sent by {sender} · {sentAtLabel}
                </Trans>
              ) : (
                <Trans>From {sender} · not sent yet</Trans>
              )}
              {row.version > 1 && ` · v${row.version}`}
            </span>
            {aiTitle && (
              <span className="min-w-0 truncate" data-testid="invoice-row-data" title={row.title}>
                · {row.title}
              </span>
            )}
          </p>
        </div>

        <div className="@2xl:block flex min-w-0 items-center justify-between gap-3">
          {slots.length > 0 && <SignerSlots slots={slots} max={6} />}
          <p className="@2xl:mt-[5px] font-semibold text-[12.5px] text-muted-foreground">
            <SignerSummary row={row} />
          </p>
        </div>

        <RowAction row={row} action={action} />
      </div>
    </article>
  );
};

const Tag = ({ code, children }: { code?: string; children?: ReactNode }) => (
  <span className="inline-flex h-[26px] min-w-[5rem] max-w-[12rem] items-center gap-1.5 rounded-full bg-muted px-2.5 font-semibold text-[13px]">
    {code && <em className="shrink-0 font-display font-extrabold text-[12.5px] text-brand-text not-italic">{code}</em>}
    {children && <span className="min-w-0 truncate">{children}</span>}
  </span>
);

const DoneTag = ({ children, title, testId }: { children: ReactNode; title: string; testId: string }) => (
  <span
    className="inline-flex h-[26px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-success-bg px-2.5 font-semibold text-[13px] text-success"
    title={title}
    data-testid={testId}
  >
    <CheckIcon className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
    {children}
  </span>
);

const SignerSummary = ({ row }: { row: InvoiceRow }) => {
  const summary = invoiceSignerSummary(row.recipients);
  const rejecter = row.recipients.find((recipient) => recipient.signingStatus === 'REJECTED');

  // O rascunho parado ainda não chegou a ninguém; a pílula já diz "não enviada".
  if (row.status === 'DRAFT') {
    return null;
  }

  if (summary.total === 0) {
    return <Trans>No one to sign</Trans>;
  }

  if (rejecter) {
    const name = signerFirstName(rejecter);

    return <Trans>{name} rejected</Trans>;
  }

  if (summary.pending === 0) {
    return <Trans>Everyone signed</Trans>;
  }

  if (summary.pending === 1) {
    return <Trans>1 signature missing</Trans>;
  }

  const pending = summary.pending;

  return <Trans>{pending} signatures missing</Trans>;
};

const STATE_PILL = 'flex h-11 w-full items-center justify-center rounded-full px-3 text-center font-bold text-[13.5px]';

const RowAction = ({ row, action }: { row: InvoiceRow; action: InvoiceRowAction }) => {
  if (action.kind === 'approve' || action.kind === 'validate' || action.kind === 'resend') {
    return (
      <Button asChild className="w-full" data-testid="invoice-row-action">
        <Link to={invoiceViewPath(row.id)}>
          {action.kind === 'approve' ? (
            <Trans>Aprovar conta</Trans>
          ) : action.kind === 'validate' ? (
            <Trans>Validate cost center</Trans>
          ) : (
            <Trans>Enviar de novo</Trans>
          )}
        </Link>
      </Button>
    );
  }

  const tone =
    action.kind === 'completed'
      ? 'bg-success-bg text-success'
      : action.kind === 'rejected'
        ? 'bg-danger-bg text-destructive'
        : 'bg-muted text-muted-foreground';

  return (
    <div className={cn(STATE_PILL, tone)} data-testid="invoice-row-state">
      <span className="min-w-0 truncate">
        <StateLabel action={action} />
      </span>
    </div>
  );
};

const StateLabel = ({ action }: { action: InvoiceRowAction }) => {
  switch (action.kind) {
    case 'completed':
      return <Trans>Invoice completed</Trans>;
    case 'rejected':
      return <Trans>Invoice rejected</Trans>;
    case 'superseded':
      return <Trans>Invoice superseded</Trans>;
    case 'cancelled':
      return <Trans>Invoice cancelled</Trans>;
    case 'draft':
      return <Trans>Not sent yet</Trans>;
    case 'waiting': {
      const name = action.firstName;

      return name ? <Trans>Waiting for {name}</Trans> : <Trans>Waiting for signatures</Trans>;
    }
    default:
      return null;
  }
};
