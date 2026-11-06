import { getSession } from '@documenso/auth/server/lib/utils/get-session';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { formatRevalleDateTime } from '@documenso/lib/revalle/date-format';
import { financeStatusLabel, invoiceViewPath } from '@documenso/lib/revalle/finance/finance-status';
import { formatInvoiceAmount } from '@documenso/lib/revalle/invoice/invoice-data'; // REVALLE: Fase 8
import { getInvoiceView } from '@documenso/lib/server-only/revalle/finance/invoice-view';
import { Button } from '@documenso/ui/primitives/button';
import { Card, CardContent } from '@documenso/ui/primitives/card';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { RecipientRole, SigningStatus } from '@prisma/client';
import { ChevronLeft, DownloadIcon, ExternalLinkIcon, TriangleAlertIcon } from 'lucide-react'; // REVALLE: DownloadIcon, Fase 8
import { isRouteErrorResponse, Link, useRevalidator } from 'react-router';

import { DocumentStatus } from '~/components/general/document/document-status';
import { GenericErrorLayout } from '~/components/general/generic-error-layout';
import PDFViewerLazy from '~/components/general/pdf-viewer/pdf-viewer-lazy';
import { AccountingCard } from '~/components/revalle/accounting/accounting-card';
import { FinanceCard } from '~/components/revalle/finance/finance-card';
import { InvoiceDuplicateSentence } from '~/components/revalle/invoice/invoice-duplicate-notice'; // REVALLE: Fase 8
import {
  financeTone,
  InvoiceCard,
  InvoiceCode,
  InvoiceRow,
  InvoiceRows,
  InvoiceStatePill,
  splitCodeLabel,
} from '~/components/revalle/invoice/invoice-ui';
import { RecipientSignerSlots } from '~/components/tables/recipient-signer-slots';
import { appMetaTags } from '~/utils/meta';

import type { Route } from './+types/notas-fiscais.$envelopeId._index';

export function meta() {
  return appMetaTags(msg`Nota fiscal`);
}

/**
 * Página da NF só de leitura (Fase 6): para quem é do Financeiro (com o cartão "Financeiro"), para a Contabilidade (Fase
 * 7, com o cartão "Contabilidade") e para quem está na NF. Quem não é de nenhum dos perfis nem está na NF recebe 404, sem
 * saber que ela existe.
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

/** REVALLE v3: a situação de cada destinatário em pílula (verde assinou, âmbar falta, vermelho recusou). */
const RecipientStatus = ({
  recipient,
}: {
  recipient: Route.ComponentProps['loaderData']['view']['recipients'][number];
}) => {
  if (recipient.role === RecipientRole.CC) {
    return (
      <InvoiceStatePill tone="neutral">
        <Trans>Recebe uma cópia</Trans>
      </InvoiceStatePill>
    );
  }

  if (recipient.signingStatus === SigningStatus.REJECTED) {
    return (
      <InvoiceStatePill tone="danger">
        <Trans>Recusou</Trans>
      </InvoiceStatePill>
    );
  }

  if (recipient.signingStatus === SigningStatus.SIGNED) {
    const at = recipient.signedAt ? formatRevalleDateTime(recipient.signedAt) : '';

    return (
      <InvoiceStatePill tone="success">
        {recipient.role === RecipientRole.APPROVER ? (
          <Trans>Aprovou em {at}</Trans>
        ) : recipient.role === RecipientRole.VIEWER ? (
          <Trans>Visualizou em {at}</Trans>
        ) : (
          <Trans>Assinou em {at}</Trans>
        )}
      </InvoiceStatePill>
    );
  }

  return (
    <InvoiceStatePill tone="warning">
      <Trans>Ainda não assinou</Trans>
    </InvoiceStatePill>
  );
};

/** Fase 8: fornecedor, número e valor que a IA leu da NF. Podem estar errados: a página diz isso e manda conferir no PDF. */
const InvoiceReadData = ({
  data,
}: {
  data: NonNullable<Route.ComponentProps['loaderData']['view']['invoiceData']>;
}) => {
  const { supplierName, invoiceNumber } = data;
  const amount = data.totalAmountCents === null ? null : formatInvoiceAmount(data.totalAmountCents);

  if (!supplierName && !invoiceNumber && !amount) {
    return null;
  }

  return (
    <div className="flex flex-col" data-testid="invoice-view-data">
      <p className="mt-1 border-border border-t pt-3 text-muted-foreground text-xs">
        <Trans>Lidos pela IA, confira no PDF</Trans>
      </p>
      <InvoiceRows>
        {amount && (
          <InvoiceRow label={<Trans>Value</Trans>}>
            <span className="font-extrabold">{amount}</span>
          </InvoiceRow>
        )}
        {supplierName && <InvoiceRow label={<Trans>Supplier</Trans>}>{supplierName}</InvoiceRow>}
        {invoiceNumber && <InvoiceRow label={<Trans>Number</Trans>}>{invoiceNumber}</InvoiceRow>}
      </InvoiceRows>
    </div>
  );
};

/**
 * Fase 8: "Esta nota parece já ter sido enviada". O Financeiro, a Contabilidade e o admin veem o título (com o link para a
 * outra nota), a data, o remetente e a situação; o dono vê só data, remetente e situação (`id` e `title` vêm nulos).
 */
const InvoiceDuplicates = ({
  duplicates,
}: {
  duplicates: Route.ComponentProps['loaderData']['view']['duplicates'];
}) => (
  <InvoiceCard tone="warning" testId="invoice-view-duplicates">
    <h2 className="flex items-start gap-2 font-display font-extrabold text-[17px] text-warning-text leading-tight">
      <TriangleAlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
      <Trans>Esta nota parece já ter sido enviada</Trans>
    </h2>
    <p>
      <Trans>Tem a mesma chave de acesso ou o mesmo arquivo de outra nota enviada. Confira antes de decidir.</Trans>
    </p>
    <ul className="flex flex-col gap-2">
      {duplicates.map((duplicate, index) => {
        return (
          <li
            key={duplicate.id ?? `${duplicate.sentAt?.toISOString() ?? 'sem-data'}-${index}`}
            className="min-w-0"
            data-testid="invoice-view-duplicate"
          >
            {duplicate.id && duplicate.title && (
              <Link
                to={invoiceViewPath(duplicate.id)}
                className="flex min-h-11 items-center break-words font-bold text-brand-text hover:underline"
                data-testid="invoice-view-duplicate-link"
              >
                {duplicate.title}
              </Link>
            )}
            <p className="break-words text-muted-foreground">
              <InvoiceDuplicateSentence duplicate={duplicate} />
            </p>
          </li>
        );
      })}
    </ul>
  </InvoiceCard>
);

export default function InvoiceViewPage({ loaderData }: Route.ComponentProps) {
  const { view } = loaderData;
  const { finance, invoiceData } = view;
  const revalidator = useRevalidator();

  const situation = financeStatusLabel(finance.status, view.status);
  const senderName = view.sender.name;

  // REVALLE v3: cabeçalho (título 28/900, uma linha de situação, ações à direita); no computador, a prévia do PDF à
  // esquerda e a coluna de cartões de 360px à direita; no celular, os cartões (com as ações do Financeiro e da
  // Contabilidade) vêm antes do PDF.
  return (
    <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 md:px-8" data-testid="invoice-view-page">
      <Link
        to="/notas-fiscais"
        className="-ml-1 inline-flex min-h-11 items-center font-semibold text-brand-text text-sm hover:underline"
      >
        <ChevronLeft className="mr-1 inline-block h-4 w-4" />
        <Trans>Notas fiscais</Trans>
      </Link>

      <div className="mt-1 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h1 className="break-words font-black font-display text-[28px] leading-[1.1] tracking-[-0.03em]">
            {view.title}
          </h1>

          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
            <DocumentStatus pill status={view.status} />
            {situation && (
              <InvoiceStatePill tone={financeTone(finance.status, view.status)} testId="invoice-view-situation">
                {situation}
              </InvoiceStatePill>
            )}
            <InvoiceStatePill tone="neutral">
              <Trans>Versão {finance.version}</Trans>
            </InvoiceStatePill>
            <span>
              <Trans>Sent by {senderName}</Trans>
            </span>
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:flex-wrap md:justify-end">
          {/* REVALLE: "Baixar PDF" (Fase 7): quem vê a nota baixa o arquivo sem depender de e-mail */}
          {view.items.map((item) => (
            <Button key={item.id} asChild variant="outline" className="w-full whitespace-normal sm:w-auto">
              <a href={`/notas-fiscais/${view.id}/pdf/${item.id}?download=1`} data-testid="invoice-view-download">
                <DownloadIcon className="mr-2 h-4 w-4 shrink-0" />
                {view.items.length > 1 ? <Trans>Baixar PDF: {item.title}</Trans> : <Trans>Baixar PDF</Trans>}
              </a>
            </Button>
          ))}
          {view.documentPath && (
            <Button asChild variant="outline" className="w-full whitespace-normal sm:w-auto">
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
        </div>
      </div>

      <div className="mt-6 grid w-full grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8">
        <div className="flex min-w-0 flex-col gap-4 lg:order-last">
          {finance.status === 'SUPERSEDED' && (
            <InvoiceCard tone="warning" testId="invoice-view-superseded">
              <p className="font-semibold text-warning-text">
                {finance.supersedeKind === 'COST_CENTER' ? (
                  <Trans>Esta versão foi substituída (centro de custo corrigido pela Contabilidade).</Trans>
                ) : (
                  <Trans>Esta versão foi substituída (conta contábil alterada pelo Financeiro).</Trans>
                )}
              </p>
              {finance.supersedeReason && (
                <p className="break-words">
                  <Trans>Motivo: {finance.supersedeReason}</Trans>
                </p>
              )}
            </InvoiceCard>
          )}

          <InvoiceCard title={<Trans>Destinatários</Trans>}>
            {view.recipients.length === 0 ? (
              <p className="text-muted-foreground">
                <Trans>Nenhum destinatário.</Trans>
              </p>
            ) : (
              <>
                <RecipientSignerSlots recipients={view.recipients} documentStatus={view.status} />
                <ul className="flex flex-col" data-testid="invoice-view-recipients">
                  {view.recipients.map((recipient) => (
                    <li
                      key={recipient.id}
                      className="flex min-w-0 flex-col gap-1.5 border-border border-t py-3 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="break-words font-semibold">{recipient.name || recipient.email}</p>
                        {recipient.name && <p className="break-all text-muted-foreground text-xs">{recipient.email}</p>}
                      </div>
                      <RecipientStatus recipient={recipient} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </InvoiceCard>

          {/* REVALLE v3: o que quem assinou viu (conta e centro); os dados lidos pela IA ficam embaixo, separados */}
          <InvoiceCard
            title={finance.status === 'LEGACY' ? <Trans>Conta contábil</Trans> : <Trans>What was signed</Trans>}
          >
            <InvoiceRows>
              <InvoiceRow label={<Trans>Conta contábil</Trans>}>
                {finance.account ? <InvoiceCode code={finance.account.code} name={finance.account.name} /> : '-'}
              </InvoiceRow>
              <InvoiceRow label={<Trans>Centro de custo</Trans>} testId="invoice-view-cost-center">
                {finance.costCenterLabel ? <InvoiceCode {...splitCodeLabel(finance.costCenterLabel)} /> : '-'}
              </InvoiceRow>
            </InvoiceRows>
            {invoiceData && <InvoiceReadData data={invoiceData} />}
          </InvoiceCard>

          {/* REVALLE v3: o aviso de duplicada fica logo antes das decisões do Financeiro e da Contabilidade */}
          {view.duplicates.length > 0 && <InvoiceDuplicates duplicates={view.duplicates} />}

          {view.viewer.isFinance && (
            <FinanceCard
              envelopeId={view.id}
              showSignedValues={false}
              onChanged={() => void revalidator.revalidate()}
            />
          )}

          {view.viewer.isAccounting && (
            <AccountingCard
              envelopeId={view.id}
              showSignedValues={false}
              onChanged={() => void revalidator.revalidate()}
            />
          )}

          {(finance.previous || finance.next) && (
            <InvoiceCard title={<Trans>Versões</Trans>}>
              {finance.previous && (
                <Link
                  to={invoiceViewPath(finance.previous.id)}
                  className="flex min-h-11 items-center break-words font-semibold text-brand-text hover:underline"
                  data-testid="invoice-view-previous"
                >
                  <Trans>Versão anterior: {finance.previous.title}</Trans>
                </Link>
              )}
              {finance.next && (
                <Link
                  to={invoiceViewPath(finance.next.id)}
                  className="flex min-h-11 items-center break-words font-semibold text-brand-text hover:underline"
                  data-testid="invoice-view-next"
                >
                  <Trans>Nova versão: {finance.next.title}</Trans>
                </Link>
              )}
            </InvoiceCard>
          )}

          <InvoiceCard title={<Trans>Informações</Trans>}>
            <InvoiceRows>
              <InvoiceRow label={<Trans>Sender</Trans>} stacked>
                {view.sender.name} <span className="font-normal text-muted-foreground">({view.sender.email})</span>
              </InvoiceRow>
              <InvoiceRow label={<Trans>Created</Trans>}>{formatRevalleDateTime(view.createdAt)}</InvoiceRow>
              {view.completedAt && (
                <InvoiceRow label={<Trans>Completed</Trans>}>{formatRevalleDateTime(view.completedAt)}</InvoiceRow>
              )}
            </InvoiceRows>
          </InvoiceCard>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {view.items.map((item) => (
            <Card key={item.id}>
              <CardContent className="p-2">
                {view.items.length > 1 && <p className="px-2 pb-2 font-semibold text-sm">{item.title}</p>}
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
