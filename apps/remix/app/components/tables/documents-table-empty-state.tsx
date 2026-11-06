import { ExtendedDocumentStatus } from '@documenso/prisma/types/extended-document-status';
import { Button } from '@documenso/ui/primitives/button';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { CheckCircle2, FileText, SearchXIcon, TimerOff, XCircle } from 'lucide-react';
import { match } from 'ts-pattern';

export type DocumentsTableEmptyStateProps = {
  status: ExtendedDocumentStatus;
  /** REVALLE: busca ou filtro ativo sem resultado: frase própria e uma ação (limpar). */
  isFiltered?: boolean;
  onClearFilters?: () => void;
};

export const DocumentsTableEmptyState = ({ status, isFiltered, onClearFilters }: DocumentsTableEmptyStateProps) => {
  const { _ } = useLingui();

  // REVALLE: redesign v3. Estado vazio num cartão: ícone pequeno, frase e (quando há filtro) uma ação.
  if (isFiltered) {
    return (
      <div
        className="flex flex-col items-center gap-y-3 rounded-card bg-card px-6 py-12 text-center shadow-card"
        data-testid="empty-document-state"
      >
        <SearchXIcon className="h-8 w-8 text-muted-foreground" strokeWidth={1.75} aria-hidden />

        <div>
          <h3 className="font-display font-extrabold text-lg tracking-[-0.02em]">
            <Trans>No documents found</Trans>
          </h3>
          <p className="mt-1 max-w-[60ch] text-muted-foreground">
            <Trans>No documents match your search and filters.</Trans>
          </p>
        </div>

        {onClearFilters && (
          <Button variant="outline" className="mt-1" onClick={onClearFilters}>
            <Trans>Clear filters</Trans>
          </Button>
        )}
      </div>
    );
  }

  const {
    title,
    message,
    icon: Icon,
  } = match(status)
    .with(ExtendedDocumentStatus.COMPLETED, () => ({
      title: msg`Nothing to do`,
      message: msg`There are no completed documents yet. Documents that you have created or received will appear here once completed.`,
      icon: CheckCircle2,
    }))
    .with(ExtendedDocumentStatus.DRAFT, () => ({
      title: msg`No active drafts`,
      message: msg`There are no active drafts at the current moment. You can upload a document to start drafting.`,
      icon: CheckCircle2,
    }))
    .with(ExtendedDocumentStatus.CANCELLED, () => ({
      title: msg`Nothing cancelled`,
      message: msg`There are no cancelled documents. Documents you cancel will remain here as a record that they were distributed.`,
      icon: XCircle,
    }))
    .with(ExtendedDocumentStatus.REJECTED, () => ({
      title: msg`No rejected documents`,
      message: msg`There are no rejected documents. Documents that a recipient declines to sign will appear here.`,
      icon: XCircle,
    }))
    .with(ExtendedDocumentStatus.EXPIRED, () => ({
      title: msg`No expired documents`,
      message: msg`There are no documents with expired signing links. You can redistribute a document to renew its expiration.`,
      icon: TimerOff,
    }))
    .with(ExtendedDocumentStatus.ALL, () => ({
      title: msg`We're all empty`,
      message: msg`You have not yet created or received any documents. To create a document please upload one.`,
      icon: FileText,
    }))
    .otherwise(() => ({
      title: msg`Nothing to do`,
      message: msg`All documents have been processed. Any new documents that are sent or received will show here.`,
      icon: CheckCircle2,
    }));

  return (
    <div
      className="flex flex-col items-center gap-y-3 rounded-card bg-card px-6 py-12 text-center shadow-card"
      data-testid="empty-document-state"
    >
      <Icon className="h-8 w-8 text-muted-foreground" strokeWidth={1.75} aria-hidden />

      <div>
        <h3 className="font-display font-extrabold text-lg tracking-[-0.02em]">{_(title)}</h3>

        <p className="mt-1 max-w-[60ch] text-muted-foreground">{_(message)}</p>
      </div>
    </div>
  );
};
