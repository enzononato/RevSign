import { getSession } from '@documenso/auth/server/lib/utils/get-session';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { formatRevalleDateTime } from '@documenso/lib/revalle/date-format';
import { financeStatusLabel, invoiceViewPath } from '@documenso/lib/revalle/finance/finance-status';
import { getInvoiceView } from '@documenso/lib/server-only/revalle/finance/invoice-view';
import { Button } from '@documenso/ui/primitives/button';
import { Card, CardContent } from '@documenso/ui/primitives/card';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { RecipientRole, SigningStatus } from '@prisma/client';
import { ChevronLeft, ExternalLinkIcon } from 'lucide-react';
import { isRouteErrorResponse, Link, useRevalidator } from 'react-router';

import { DocumentStatus } from '~/components/general/document/document-status';
import { GenericErrorLayout } from '~/components/general/generic-error-layout';
import PDFViewerLazy from '~/components/general/pdf-viewer/pdf-viewer-lazy';
import { FinanceCard } from '~/components/revalle/finance/finance-card';
import { appMetaTags } from '~/utils/meta';

import type { Route } from './+types/notas-fiscais.$envelopeId._index';

export function meta() {
  return appMetaTags(msg`Nota fiscal`);
}

/**
 * Página da NF só de leitura (Fase 6): para quem é do Financeiro (com o cartão "Financeiro") e para quem está na NF.
 * Quem não é do Financeiro nem está na NF recebe 404, sem saber que ela existe.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { user } = await getSession(request);

  const view = await getInvoiceView({ envelopeId: params.envelopeId, userId: user.id }).catch((err) => {
    if (AppError.parseError(err).code === AppErrorCode.NOT_FOUND) {
      throw new Response('Not Found', { status: 404 });
    }

    throw err;
  });

  return { view };
}

const RecipientStatus = ({
  recipient,
}: {
  recipient: Route.ComponentProps['loaderData']['view']['recipients'][number];
}) => {
  if (recipient.role === RecipientRole.CC) {
    return <Trans>Recebe uma cópia</Trans>;
  }

  if (recipient.signingStatus === SigningStatus.REJECTED) {
    return <Trans>Recusou</Trans>;
  }

  if (recipient.signingStatus === SigningStatus.SIGNED) {
    const at = recipient.signedAt ? formatRevalleDateTime(recipient.signedAt) : '';

    return recipient.role === RecipientRole.APPROVER ? (
      <Trans>Aprovou em {at}</Trans>
    ) : recipient.role === RecipientRole.VIEWER ? (
      <Trans>Visualizou em {at}</Trans>
    ) : (
      <Trans>Assinou em {at}</Trans>
    );
  }

  return <Trans>Ainda não assinou</Trans>;
};

export default function InvoiceViewPage({ loaderData }: Route.ComponentProps) {
  const { view } = loaderData;
  const { finance } = view;
  const revalidator = useRevalidator();

  const situation = financeStatusLabel(finance.status, view.status);

  return (
    <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 md:px-8" data-testid="invoice-view-page">
      <Link to="/notas-fiscais" className="flex min-h-11 items-center text-documenso-700 hover:opacity-80">
        <ChevronLeft className="mr-2 inline-block h-5 w-5" />
        <Trans>Notas fiscais</Trans>
      </Link>

      <h1 className="mt-2 break-words font-semibold text-2xl md:text-3xl">{view.title}</h1>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-muted-foreground text-sm">
        <DocumentStatus status={view.status} inheritColor />
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
          <Trans>Versão {finance.version}</Trans>
        </span>
        {situation && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs" data-testid="invoice-view-situation">
            {situation}
          </span>
        )}
      </div>

      <div className="mt-6 grid w-full grid-cols-12 gap-6 lg:gap-8">
        <div className="col-span-12 flex min-w-0 flex-col gap-4 lg:order-last lg:col-span-5">
          {finance.status === 'SUPERSEDED' && (
            <section
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
              data-testid="invoice-view-superseded"
            >
              <p className="font-medium">
                <Trans>Esta versão foi substituída (conta contábil alterada pelo Financeiro).</Trans>
              </p>
              {finance.supersedeReason && (
                <p className="mt-1 break-words">
                  <Trans>Motivo: {finance.supersedeReason}</Trans>
                </p>
              )}
            </section>
          )}

          {(finance.previous || finance.next) && (
            <section className="flex flex-col gap-1 rounded-xl border border-border bg-widget p-4 text-sm dark:bg-background">
              <h2 className="font-medium">
                <Trans>Versões</Trans>
              </h2>
              {finance.previous && (
                <Link
                  to={invoiceViewPath(finance.previous.id)}
                  className="flex min-h-11 items-center break-words text-documenso-700 hover:underline"
                  data-testid="invoice-view-previous"
                >
                  <Trans>Versão anterior: {finance.previous.title}</Trans>
                </Link>
              )}
              {finance.next && (
                <Link
                  to={invoiceViewPath(finance.next.id)}
                  className="flex min-h-11 items-center break-words text-documenso-700 hover:underline"
                  data-testid="invoice-view-next"
                >
                  <Trans>Nova versão: {finance.next.title}</Trans>
                </Link>
              )}
            </section>
          )}

          {view.viewer.isFinance ? (
            <FinanceCard envelopeId={view.id} onChanged={() => void revalidator.revalidate()} />
          ) : (
            <section className="flex flex-col gap-1 rounded-xl border border-border bg-widget p-4 text-sm dark:bg-background">
              <h2 className="font-medium">
                <Trans>Conta contábil</Trans>
              </h2>
              <p className="break-words">
                {finance.deferred ? (
                  finance.status === 'LEGACY' ? (
                    <Trans>A definir pela contabilidade.</Trans>
                  ) : (
                    <Trans>A definir pelo Financeiro.</Trans>
                  )
                ) : finance.account ? (
                  `${finance.account.code} – ${finance.account.name ?? ''}`
                ) : (
                  '-'
                )}
              </p>
              {situation && <p className="text-muted-foreground">{situation}</p>}
            </section>
          )}

          <section className="flex flex-col gap-2 rounded-xl border border-border bg-widget p-4 text-sm dark:bg-background">
            <h2 className="font-medium">
              <Trans>Informações</Trans>
            </h2>
            <p className="break-words">
              <Trans>
                Remetente: {view.sender.name} ({view.sender.email})
              </Trans>
            </p>
            <p>
              <Trans>Criado em {formatRevalleDateTime(view.createdAt)}</Trans>
            </p>
            {view.completedAt && (
              <p>
                <Trans>Concluído em {formatRevalleDateTime(view.completedAt)}</Trans>
              </p>
            )}
            {view.documentPath && (
              <Button asChild variant="outline" className="mt-1 h-11 w-full whitespace-normal sm:w-auto sm:self-start">
                <Link to={view.documentPath}>
                  <ExternalLinkIcon className="mr-2 h-4 w-4 shrink-0" />
                  {view.viewer.isOwner ? (
                    <Trans>Abrir a página do documento</Trans>
                  ) : (
                    <Trans>Abrir no painel do admin</Trans>
                  )}
                </Link>
              </Button>
            )}
          </section>

          <section className="flex flex-col gap-2 rounded-xl border border-border bg-widget p-4 text-sm dark:bg-background">
            <h2 className="font-medium">
              <Trans>Destinatários</Trans>
            </h2>
            {view.recipients.length === 0 ? (
              <p className="text-muted-foreground">
                <Trans>Nenhum destinatário.</Trans>
              </p>
            ) : (
              <ul className="flex flex-col gap-2" data-testid="invoice-view-recipients">
                {view.recipients.map((recipient) => (
                  <li key={recipient.id} className="min-w-0">
                    <p className="break-words font-medium">{recipient.name || recipient.email}</p>
                    {recipient.name && <p className="break-all text-muted-foreground">{recipient.email}</p>}
                    <p className="text-muted-foreground">
                      <RecipientStatus recipient={recipient} />
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="col-span-12 flex min-w-0 flex-col gap-4 lg:col-span-7">
          {view.items.map((item) => (
            <Card key={item.id} className="rounded-xl before:rounded-xl" gradient>
              <CardContent className="p-2">
                {view.items.length > 1 && <p className="px-2 pb-2 font-medium text-sm">{item.title}</p>}
                <PDFViewerLazy
                  key={`${item.id}-${item.documentDataId}`}
                  data={`/notas-fiscais/${view.id}/pdf/${item.id}?v=${item.documentDataId}`}
                  scrollParentRef="window"
                />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const errorCode = isRouteErrorResponse(error) ? error.status : 500;

  return (
    <GenericErrorLayout
      errorCode={errorCode}
      errorCodeMap={{
        404: {
          heading: msg`Nota fiscal não encontrada`,
          subHeading: msg`Erro 404`,
          message: msg`Esta nota fiscal não existe ou você não tem acesso a ela.`,
        },
      }}
      secondaryButton={null}
      primaryButton={
        <Button asChild>
          <Link to="/notas-fiscais">
            <Trans>Voltar para Notas fiscais</Trans>
          </Link>
        </Button>
      }
    />
  );
}
