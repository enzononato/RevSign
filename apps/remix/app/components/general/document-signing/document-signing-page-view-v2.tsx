import { useCurrentEnvelopeRender } from '@documenso/lib/client-only/providers/envelope-render-provider';
import { PDF_VIEWER_ERROR_MESSAGES } from '@documenso/lib/constants/pdf-viewer-i18n';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { EnvelopeType, RecipientRole } from '@prisma/client';
import { motion } from 'framer-motion';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  BanIcon,
  DownloadCloudIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PaperclipIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { match } from 'ts-pattern';

import { EnvelopeDownloadDialog } from '~/components/dialogs/envelope-download-dialog';
import { SignFieldCheckboxDialog } from '~/components/dialogs/sign-field-checkbox-dialog';
import { SignFieldDropdownDialog } from '~/components/dialogs/sign-field-dropdown-dialog';
import { SignFieldEmailDialog } from '~/components/dialogs/sign-field-email-dialog';
import { SignFieldInitialsDialog } from '~/components/dialogs/sign-field-initials-dialog';
import { SignFieldNameDialog } from '~/components/dialogs/sign-field-name-dialog';
import { SignFieldNumberDialog } from '~/components/dialogs/sign-field-number-dialog';
import { SignFieldSignatureDialog } from '~/components/dialogs/sign-field-signature-dialog';
import { SignFieldTextDialog } from '~/components/dialogs/sign-field-text-dialog';
import { useEmbedSigningContext } from '~/components/embed/embed-signing-context';
import { EnvelopeSignerPageRenderer } from '~/components/general/envelope-signing/envelope-signer-page-renderer';
import { EnvelopePdfViewer } from '~/components/general/pdf-viewer/envelope-pdf-viewer';
import { PublicLegalLinks } from '~/components/general/public-legal-links';
import {
  SigningInvoiceAccountBlock,
  useSigningInvoiceAccount,
} from '~/components/revalle/invoice/signing-invoice-account'; // REVALLE:

import { BrandingLogo } from '../branding-logo';
import { DocumentSigningAttachmentsPopover } from '../document-signing/document-signing-attachments-popover';
import { EnvelopeItemSelector } from '../envelope-editor/envelope-file-selector';
import EnvelopeSignerForm from '../envelope-signing/envelope-signer-form';
import { EnvelopeSignerHeader } from '../envelope-signing/envelope-signer-header';
import { EnvelopeSignerSlotsBlock } from '../envelope-signing/envelope-signer-slots'; // REVALLE:
import { EnvelopeSignerCompleteDialog } from '../envelope-signing/envelope-signing-complete-dialog'; // REVALLE:
import { DocumentSigningMobileWidget } from './document-signing-mobile-widget';
import { DocumentSigningRejectDialog } from './document-signing-reject-dialog';
import { useRequiredEnvelopeSigningContext } from './envelope-signing-provider';

export const DocumentSigningPageViewV2 = () => {
  const { envelopeItems, currentEnvelopeItem, setCurrentEnvelopeItem } = useCurrentEnvelopeRender();

  const {
    isDirectTemplate,
    envelope,
    recipient,
    recipientFields,
    recipientFieldsRemaining,
    requiredRecipientFields,
    selectedAssistantRecipientFields,
  } = useRequiredEnvelopeSigningContext();

  const {
    isEmbed = false,
    allowDocumentRejection = true,
    hidePoweredBy = true,
    onDocumentRejected,
  } = useEmbedSigningContext() || {};

  const { t } = useLingui();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  /**
   * The total remaining fields remaining for the current recipient or selected assistant recipient.
   *
   * Includes both optional and required fields.
   */
  const remainingFields = useMemo(() => {
    if (recipient.role === RecipientRole.ASSISTANT) {
      return selectedAssistantRecipientFields.filter((field) => !field.inserted);
    }

    return recipientFields.filter((field) => !field.inserted);
  }, [recipientFieldsRemaining, selectedAssistantRecipientFields, currentEnvelopeItem]);

  // REVALLE (redesign v3): faixa azul no topo; no celular (abaixo de lg) a composição do preview aprovado (cartões "Nota fiscal
  // em PDF", "O que você está assinando" e "Assinaturas", o PDF com os campos logo abaixo e a barra fixa com o botão de
  // concluir); no desktop o mesmo painel lateral, agora um cartão branco, ao lado do PDF. A página rola na janela.
  const isInvoice = useSigningInvoiceAccount() !== null;

  return (
    <div className="min-h-screen w-full bg-background">
      <SignFieldEmailDialog.Root />
      <SignFieldTextDialog.Root />
      <SignFieldNumberDialog.Root />
      <SignFieldNameDialog.Root />
      <SignFieldInitialsDialog.Root />
      <SignFieldDropdownDialog.Root />
      <SignFieldSignatureDialog.Root />
      <SignFieldCheckboxDialog.Root />

      <EnvelopeSignerHeader showDesktopCompleteAction={isSidebarCollapsed} />

      {/* Main Content Area */}
      <div className="w-full lg:flex lg:items-start lg:gap-6 lg:px-6 lg:pt-6">
        {/* Left Section - Step Navigation */}
        <aside
          className={cn(
            'embed--DocumentWidgetContainer flex flex-col gap-3 px-4 pt-4',
            'lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:flex-shrink-0 lg:gap-0 lg:overflow-y-auto lg:rounded-card lg:bg-card lg:p-0 lg:shadow-card lg:transition-[width] lg:duration-300 lg:dark:shadow-[0_0_0_1px_hsl(var(--border))]',
            isSidebarCollapsed ? 'lg:w-12' : 'lg:w-[340px]',
          )}
        >
          {isSidebarCollapsed && (
            <div className="hidden justify-center py-2 lg:flex">
              <Button
                variant="ghost"
                className="h-9 w-9 p-0"
                aria-label={t`Expand sidebar`}
                onClick={() => setIsSidebarCollapsed(false)}
              >
                <PanelLeftOpenIcon className="h-4 w-4" />
              </Button>
            </div>
          )}

          <div className={cn('contents lg:flex lg:flex-col lg:p-5', isSidebarCollapsed && 'lg:hidden')}>
            {/* Desktop: título, campos que faltam e progresso */}
            <div className="hidden lg:block">
              <h2 className="flex items-center justify-between gap-2 font-display font-extrabold text-[17px] text-foreground">
                {match(recipient.role)
                  .with(RecipientRole.VIEWER, () => <Trans>View Document</Trans>)
                  .with(RecipientRole.SIGNER, () => <Trans>Sign Document</Trans>)
                  .with(RecipientRole.APPROVER, () => <Trans>Approve Document</Trans>)
                  .with(RecipientRole.ASSISTANT, () => <Trans>Assist Document</Trans>)
                  .otherwise(() => null)}

                <div className="ml-2 flex items-center gap-1">
                  {/* REVALLE: sem o selo com zero campos (no pt-BR o plural "one" pega o 0 e dizia "Falta 1 campo") */}
                  {recipientFieldsRemaining.length > 0 && (
                    <span className="whitespace-nowrap rounded-full bg-muted px-2.5 py-0.5 font-sans font-semibold text-[12px] text-muted-foreground tabular-nums">
                      <Plural
                        value={recipientFieldsRemaining.length}
                        one="1 Field Remaining"
                        other="# Fields Remaining"
                      />
                    </span>
                  )}

                  <Button
                    variant="ghost"
                    className="h-8 w-8 p-0"
                    aria-label={t`Collapse sidebar`}
                    onClick={() => setIsSidebarCollapsed(true)}
                  >
                    <PanelLeftCloseIcon className="h-4 w-4" />
                  </Button>
                </div>
              </h2>

              <div className="relative mt-3 h-[5px] overflow-hidden rounded-full bg-muted">
                <motion.div
                  layout="size"
                  layoutId="document-flow-container-step"
                  className="absolute inset-y-0 left-0 rounded-full bg-primary"
                  style={{
                    width: `${requiredRecipientFields.length === 0 ? 100 : 100 - (100 / requiredRecipientFields.length) * (recipientFieldsRemaining.length ?? 0)}%`,
                  }}
                />
              </div>
            </div>

            {/* Celular: o PDF com os campos fica logo abaixo dos cartões */}
            <SigningDocumentCard isInvoice={isInvoice} className={cn(PHONE_CARD, 'lg:hidden')} />

            {/* REVALLE: conta da NF (Fase 6), o que é assinado */}
            <SigningInvoiceAccountBlock className={cn(PHONE_CARD, PANEL_BLOCK)} />

            <EnvelopeSignerSlotsBlock className={cn(PHONE_CARD, PANEL_BLOCK)} />

            {/* Desktop: dados de quem assina e o botão de concluir */}
            <div className={cn('hidden lg:block', PANEL_BLOCK)}>
              <div className="embed--DocumentWidgetContent space-y-3">
                <EnvelopeSignerForm />
              </div>

              <div className="mt-5">
                <EnvelopeSignerCompleteDialog buttonSize="lg" />
              </div>
            </div>

            {/* Quick Actions. */}
            {!isDirectTemplate && (
              <div className={cn('embed--Actions hidden space-y-1 lg:block', PANEL_BLOCK)}>
                <h4 className="mb-2 font-display font-extrabold text-[15px] text-foreground">
                  <Trans>Actions</Trans>
                </h4>

                <DocumentSigningAttachmentsPopover
                  envelopeId={envelope.id}
                  token={recipient.token}
                  trigger={
                    <Button variant="ghost" size="sm" className="w-full justify-start">
                      <PaperclipIcon className="mr-2 h-4 w-4" />
                      <Trans>Attachments</Trans>
                    </Button>
                  }
                />

                <EnvelopeDownloadDialog
                  envelopeId={envelope.id}
                  envelopeStatus={envelope.status}
                  envelopeItems={envelope.envelopeItems}
                  token={recipient.token}
                  trigger={
                    <Button variant="ghost" size="sm" className="w-full justify-start">
                      <DownloadCloudIcon className="mr-2 h-4 w-4" />
                      <Trans>Download PDF</Trans>
                    </Button>
                  }
                />

                {envelope.type === EnvelopeType.DOCUMENT && allowDocumentRejection && (
                  <DocumentSigningRejectDialog
                    documentId={mapSecondaryIdToDocumentId(envelope.secondaryId)}
                    token={recipient.token}
                    onRejected={
                      onDocumentRejected &&
                      ((reason) =>
                        onDocumentRejected({
                          token: recipient.token,
                          documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
                          envelopeId: envelope.id,
                          recipientId: recipient.id,
                          reason,
                        }))
                    }
                    trigger={
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start hover:bg-danger-bg hover:text-destructive"
                      >
                        <BanIcon className="mr-2 h-4 w-4" />
                        <Trans>Reject Document</Trans>
                      </Button>
                    }
                  />
                )}
              </div>
            )}

            <div className="embed--DocumentWidgetFooter hidden lg:block">
              {/* Footer of left sidebar. */}
              {!isEmbed && (
                <div className={PANEL_BLOCK}>
                  <Button asChild variant="ghost" size="sm" className="w-full justify-start">
                    <Link to="/">
                      <ArrowLeftIcon className="mr-2 h-4 w-4" />
                      <Trans>Return</Trans>
                    </Link>
                  </Button>
                </div>
              )}

              {!isEmbed && <PublicLegalLinks className="mt-3 justify-start px-3" />}
            </div>
          </div>
        </aside>

        <div id={DOCUMENT_ANCHOR_ID} className="embed--DocumentContainer min-w-0 flex-1 scroll-mt-4 lg:scroll-mt-6">
          <div className="flex flex-col">
            {/* Horizontal envelope item selector */}
            {envelopeItems.length > 1 && (
              <div className="flex h-fit space-x-2 overflow-x-auto p-2 pt-4 sm:p-4 lg:px-0 lg:pt-0">
                {envelopeItems.map((doc, i) => (
                  <EnvelopeItemSelector
                    key={doc.id}
                    number={i + 1}
                    primaryText={doc.title}
                    secondaryText={
                      <Plural
                        one="1 Field"
                        other="# Fields"
                        value={remainingFields.filter((field) => field.envelopeItemId === doc.id).length}
                      />
                    }
                    isSelected={currentEnvelopeItem?.id === doc.id}
                    buttonProps={{ onClick: () => setCurrentEnvelopeItem(doc.id) }}
                  />
                ))}
              </div>
            )}

            {/* Document View */}
            <div className="embed--DocumentViewer flex flex-col items-center justify-center p-2 pt-4 sm:p-4 lg:p-0 lg:pb-6">
              {currentEnvelopeItem ? (
                <EnvelopePdfViewer
                  key={currentEnvelopeItem.id}
                  customPageRenderer={EnvelopeSignerPageRenderer}
                  scrollParentRef="window"
                  errorMessage={PDF_VIEWER_ERROR_MESSAGES.signing}
                />
              ) : (
                <div className="flex flex-col items-center justify-center py-32">
                  <p className="text-foreground text-sm">
                    <Trans>No document selected</Trans>
                  </p>
                </div>
              )}

              {!hidePoweredBy && (
                <a
                  href="https://documenso.com"
                  target="_blank"
                  className="fixed right-0 bottom-0 z-40 hidden cursor-pointer rounded-tl bg-primary px-2 py-1 font-medium text-primary-foreground text-xs opacity-60 hover:opacity-100 lg:block"
                  rel="noopener"
                >
                  <span>
                    <Trans>Powered by</Trans>
                  </span>
                  <BrandingLogo className="ml-2 inline-block h-[14px]" />
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Mobile widget: barra fixa com o botão de concluir (o rodapé "Código-fonte" tem folga para ela) */}
      <div className="lg:hidden">
        <DocumentSigningMobileWidget />
      </div>
    </div>
  );
};

const DOCUMENT_ANCHOR_ID = 'revalle-documento';

/** Cartão do celular (o painel do desktop desfaz o cartão: vira um bloco do cartão branco do painel). */
const PHONE_CARD =
  'rounded-card bg-card px-[18px] py-4 shadow-card dark:shadow-[0_0_0_1px_hsl(var(--border))] lg:rounded-none lg:bg-transparent lg:px-0 lg:py-0 lg:shadow-none lg:dark:shadow-none';

/** Bloco do painel do desktop, separado do anterior por um fio. */
const PANEL_BLOCK = 'lg:mt-5 lg:border-border lg:border-t lg:pt-5';

/**
 * REVALLE (redesign v3): cartão "Nota fiscal em PDF" do celular. "Ler o documento inteiro" leva ao PDF logo abaixo, onde
 * ficam os campos para preencher (o fluxo dos campos não muda).
 */
const SigningDocumentCard = ({ isInvoice, className }: { isInvoice: boolean; className?: string }) => {
  const onReadClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const target = document.getElementById(DOCUMENT_ANCHOR_ID);

    if (!target) {
      return;
    }

    event.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className={cn('flex items-center gap-3.5', className)}>
      <div
        aria-hidden
        className="flex h-[72px] w-14 flex-shrink-0 flex-col gap-1 rounded-lg bg-white px-[7px] py-2 shadow-[0_0_0_1px_hsl(var(--border)),0_4px_10px_-4px_rgba(20,27,46,0.25)]"
      >
        {PAGE_LINES.map((width, index) => (
          <i
            key={`${width}-${index}`}
            className={cn('block h-[3px] rounded-sm bg-[#D9DDE6] dark:bg-[#C9CED9]', width)}
          />
        ))}
      </div>

      <div className="min-w-0">
        <p className="font-bold text-[14.5px]">
          {isInvoice ? <Trans>Invoice PDF</Trans> : <Trans>PDF document</Trans>}
        </p>

        <a
          href={`#${DOCUMENT_ANCHOR_ID}`}
          onClick={onReadClick}
          className="-my-2.5 inline-flex min-h-11 items-center gap-1 font-bold text-[14px] text-brand-text underline-offset-4 hover:underline"
        >
          <Trans>Read the full document</Trans>
          <ArrowDownIcon aria-hidden className="h-4 w-4" />
        </a>
      </div>
    </div>
  );
};

const PAGE_LINES = ['w-full', 'w-[70%]', 'w-full', 'w-[55%]', 'w-full', 'w-[80%]'];
