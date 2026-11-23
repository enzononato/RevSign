import { EnvelopeRenderProvider } from '@documenso/lib/client-only/providers/envelope-render-provider';
import { useSession } from '@documenso/lib/client-only/providers/session';
import { PDF_VIEWER_ERROR_MESSAGES } from '@documenso/lib/constants/pdf-viewer-i18n';
import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { getDocumentDataUrlForPdfViewer } from '@documenso/lib/utils/envelope-download';
import { formatDocumentsPath } from '@documenso/lib/utils/teams';
import { trpc } from '@documenso/trpc/react';
import {
  DocumentReadOnlyFields,
  mapFieldsWithRecipients,
} from '@documenso/ui/components/document/document-read-only-fields';
import { cn } from '@documenso/ui/lib/utils';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import { Card, CardContent } from '@documenso/ui/primitives/card';
import { Spinner } from '@documenso/ui/primitives/spinner';
import { msg } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import { DocumentStatus } from '@prisma/client';
import { ChevronLeft } from 'lucide-react';
import { Link } from 'react-router';
import { match } from 'ts-pattern';

import { DocumentPageViewButton } from '~/components/general/document/document-page-view-button';
import { DocumentPageViewDropdown } from '~/components/general/document/document-page-view-dropdown';
import { DocumentPageViewInformation } from '~/components/general/document/document-page-view-information';
import { DocumentPageViewRecentActivity } from '~/components/general/document/document-page-view-recent-activity';
import { DocumentPageViewRecipients } from '~/components/general/document/document-page-view-recipients';
import { DocumentRecipientLinkCopyDialog } from '~/components/general/document/document-recipient-link-copy-dialog';
import { DocumentStatus as DocumentStatusComponent } from '~/components/general/document/document-status';
import { EnvelopeRendererFileSelector } from '~/components/general/envelope-editor/envelope-file-selector';
import { EnvelopeGenericPageRenderer } from '~/components/general/envelope-editor/envelope-generic-page-renderer';
import { GenericErrorLayout } from '~/components/general/generic-error-layout';
import { EnvelopePdfViewer } from '~/components/general/pdf-viewer/envelope-pdf-viewer';
import PDFViewerLazy from '~/components/general/pdf-viewer/pdf-viewer-lazy';
import { InvoiceAccountCard } from '~/components/revalle/invoice/invoice-account-card'; // REVALLE:
import { useCurrentTeam } from '~/providers/team';

import type { Route } from './+types/documents.$id._index';

export default function DocumentPage({ params }: Route.ComponentProps) {
  const { user } = useSession();

  const team = useCurrentTeam();

  const {
    data: envelope,
    isLoading: isLoadingEnvelope,
    isError: isErrorEnvelope,
  } = trpc.envelope.get.useQuery(
    {
      envelopeId: params.id,
    },
    {
      ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
    },
  );

  const { data: fieldSignatures } = trpc.envelope.field.getSignatures.useQuery(
    {
      envelopeId: params.id,
    },
    {
      ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
      enabled: envelope && envelope.internalVersion === 2 && envelope.status === DocumentStatus.PENDING,
    },
  );

  if (isLoadingEnvelope) {
    return (
      <div className="flex w-screen flex-col items-center justify-center gap-2 py-64 text-foreground">
        <Spinner />
        <Trans>Loading</Trans>
      </div>
    );
  }

  if (isErrorEnvelope || !envelope) {
    return (
      <GenericErrorLayout
        errorCode={404}
        errorCodeMap={{
          404: {
            heading: msg`Not found`,
            subHeading: msg`404 Not found`,
            message: msg`The document you are looking for may have been removed, renamed or may have never existed.`,
          },
        }}
        primaryButton={
          <Button asChild>
            <Link to={`/t/${team.url}/documents`}>
              <Trans>Go back</Trans>
            </Link>
          </Button>
        }
      />
    );
  }

  const documentRootPath = formatDocumentsPath(team.url);

  const isMultiEnvelopeItem = envelope.envelopeItems.length > 1 && envelope.internalVersion === 2;

  // REVALLE v3: cabeçalho (título 28/900, uma linha de situação, ação principal à direita), duas colunas no computador
  // (prévia do PDF num cartão à esquerda, coluna de cartões de 360px à direita) e uma coluna no celular.
  return (
    <div className="mx-auto -mt-4 w-full max-w-screen-xl px-4 md:px-8">
      {envelope.status === DocumentStatus.PENDING && (
        <DocumentRecipientLinkCopyDialog recipients={envelope.recipients} />
      )}

      <Link
        to={documentRootPath}
        className="-ml-1 inline-flex min-h-11 items-center font-semibold text-brand-text text-sm hover:underline"
      >
        <ChevronLeft className="mr-1 inline-block h-4 w-4" />
        <Trans>Documents</Trans>
      </Link>

      <div className="mt-1 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h1
            className="break-words font-black font-display text-[28px] leading-[1.1] tracking-[-0.03em]"
            title={envelope.title}
          >
            {envelope.title}
          </h1>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-muted-foreground text-sm">
            <DocumentStatusComponent pill status={envelope.status} />

            <span>
              {match(envelope.status)
                .with(DocumentStatus.COMPLETED, () => <Trans>This document has been signed by all recipients</Trans>)
                .with(DocumentStatus.REJECTED, () => <Trans>This document has been rejected by a recipient</Trans>)
                .with(DocumentStatus.CANCELLED, () => <Trans>This document has been cancelled</Trans>)
                .with(DocumentStatus.DRAFT, () => (
                  <Trans>This document is currently a draft and has not been sent</Trans>
                ))
                .with(DocumentStatus.PENDING, () => {
                  const pendingRecipients = envelope.recipients.filter(
                    (recipient) => recipient.signingStatus === 'NOT_SIGNED',
                  );

                  return (
                    <Plural
                      value={pendingRecipients.length}
                      one="Waiting on 1 recipient"
                      other="Waiting on # recipients"
                    />
                  );
                })
                .exhaustive()}
            </span>

            {envelope.deletedAt && (
              <Badge variant="destructive">
                <Trans>Document deleted</Trans>
              </Badge>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2" data-testid="document-page-actions">
          <div className="min-w-0 flex-1 md:w-auto md:min-w-[11rem] md:flex-none">
            <DocumentPageViewButton envelope={envelope} />
          </div>

          <DocumentPageViewDropdown envelope={envelope} />
        </div>
      </div>

      <div className="mt-6 grid w-full grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8">
        {envelope.internalVersion === 2 ? (
          <div className="relative min-w-0">
            <EnvelopeRenderProvider
              version="current"
              envelope={envelope}
              envelopeItems={envelope.envelopeItems}
              token={undefined}
              fields={envelope.fields}
              signatures={fieldSignatures}
              recipients={envelope.recipients}
              overrideSettings={{
                showRecipientSigningStatus: true,
                showRecipientTooltip: true,
              }}
            >
              {isMultiEnvelopeItem && <EnvelopeRendererFileSelector fields={envelope.fields} className="mb-4 p-0" />}

              <Card>
                <CardContent className="p-2">
                  <EnvelopePdfViewer
                    customPageRenderer={EnvelopeGenericPageRenderer}
                    scrollParentRef="window"
                    errorMessage={PDF_VIEWER_ERROR_MESSAGES.preview}
                  />
                </CardContent>
              </Card>
            </EnvelopeRenderProvider>
          </div>
        ) : (
          <Card className="relative min-w-0">
            <CardContent className="p-2">
              {envelope.status !== DocumentStatus.COMPLETED && (
                <DocumentReadOnlyFields
                  fields={mapFieldsWithRecipients(envelope.fields, envelope.recipients)}
                  documentMeta={envelope.documentMeta || undefined}
                  showRecipientTooltip={true}
                  showRecipientColors={true}
                  recipientIds={envelope.recipients.map((recipient) => recipient.id)}
                />
              )}

              <PDFViewerLazy
                data={getDocumentDataUrlForPdfViewer({
                  envelopeId: envelope.id,
                  envelopeItemId: envelope.envelopeItems[0]?.id,
                  documentDataId: envelope.envelopeItems[0]?.documentDataId,
                  version: 'current',
                  token: undefined,
                  presignToken: undefined,
                })}
                key={envelope.envelopeItems[0]?.id}
                scrollParentRef="window"
              />
            </CardContent>
          </Card>
        )}

        <div className={cn('min-w-0', isMultiEnvelopeItem && 'lg:mt-20')}>
          <div className="space-y-4">
            {/* Recipients section. */}
            <DocumentPageViewRecipients envelope={envelope} documentRootPath={documentRootPath} />

            {/* REVALLE: conta contábil da nota fiscal (dono e admin podem trocar depois do envio). */}
            <InvoiceAccountCard envelope={envelope} />

            {/* Document information section. */}
            <DocumentPageViewInformation envelope={envelope} userId={user.id} />

            {/* Recent activity section. */}
            <DocumentPageViewRecentActivity
              documentId={mapSecondaryIdToDocumentId(envelope.secondaryId)}
              userId={user.id}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
