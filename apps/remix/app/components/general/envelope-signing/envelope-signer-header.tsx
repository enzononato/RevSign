import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { Button } from '@documenso/ui/primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@documenso/ui/primitives/dropdown-menu';
import { Plural, Trans } from '@lingui/react/macro';
import { EnvelopeType, RecipientRole } from '@prisma/client';
import { BanIcon, DownloadCloudIcon } from 'lucide-react';
import { Link } from 'react-router';
import { match } from 'ts-pattern';

import { EnvelopeDownloadDialog } from '~/components/dialogs/envelope-download-dialog';
import { useEmbedSigningContext } from '~/components/embed/embed-signing-context';
import { PublicLegalLinksDropdownMenuItems } from '~/components/general/public-legal-links';
import { RevsignWordmark } from '~/components/revalle/shell/revsign-wordmark'; // REVALLE:
import { SigningBand } from '~/components/revalle/signing-gate/signing-band'; // REVALLE:

import { DocumentSigningRejectDialog } from '../document-signing/document-signing-reject-dialog';
import { useRequiredEnvelopeSigningContext } from '../document-signing/envelope-signing-provider';
import { useEnvelopeSignerSlots } from './envelope-signer-slots'; // REVALLE:
import { EnvelopeSignerCompleteDialog } from './envelope-signing-complete-dialog';

export type EnvelopeSignerHeaderProps = {
  /** REVALLE (redesign v3): no desktop, o "Concluir" fica no painel; com o painel recolhido ele volta para a faixa. */
  showDesktopCompleteAction?: boolean;
};

// REVALLE (redesign v3): a barra branca virou a faixa azul do preview (marca, etapa, título e remetente). No celular, o menu
// "Ações" (baixar, recusar, links legais) continua no canto, como último botão do <nav>.
export const EnvelopeSignerHeader = ({ showDesktopCompleteAction = false }: EnvelopeSignerHeaderProps) => {
  const { envelopeData, envelope, recipientFieldsRemaining, recipient } = useRequiredEnvelopeSigningContext();
  const { position, totalCount } = useEnvelopeSignerSlots();

  const isEmbedSigning = useEmbedSigningContext() !== null;
  const hasCustomBrandingLogo = envelopeData.settings.brandingEnabled && Boolean(envelopeData.settings.brandingLogo);

  const senderName = envelopeData.sender.name || envelopeData.sender.email;

  const logo = isEmbedSigning ? (
    <span />
  ) : hasCustomBrandingLogo ? (
    <img
      src={`/api/branding/logo/team/${envelope.teamId}`}
      alt={`${envelope.team.name}'s Logo`}
      className="h-7 w-auto flex-shrink-0 rounded-md bg-white px-1.5 py-1"
    />
  ) : (
    <Link to="/" className="inline-flex min-h-11 flex-shrink-0 items-center rounded-md">
      <RevsignWordmark variant="onBrand" size="sm" className="lg:hidden" />
      <RevsignWordmark variant="onBrand" size="sm" withTagline className="hidden lg:inline-flex" />
    </Link>
  );

  return (
    <SigningBand
      as="nav"
      layout="signing"
      className="embed--DocumentWidgetHeader"
      logo={logo}
      title={<span title={envelope.title}>{envelope.title}</span>}
      subtitle={
        senderName ? (
          <>
            <Trans>Documento enviado por {senderName}</Trans>
            <span className="hidden lg:inline">
              {' · '}
              {match(recipient.role)
                .with(RecipientRole.VIEWER, () => <Trans>Viewer</Trans>)
                .with(RecipientRole.SIGNER, () => <Trans>Signer</Trans>)
                .with(RecipientRole.APPROVER, () => <Trans>Approver</Trans>)
                .with(RecipientRole.ASSISTANT, () => <Trans>Assistant</Trans>)
                .otherwise(() => null)}
            </span>
          </>
        ) : undefined
      }
      step={
        position !== null && totalCount > 1 ? (
          <Trans>
            Signature {position} of {totalCount}
          </Trans>
        ) : undefined
      }
      actions={
        <>
          {showDesktopCompleteAction && (
            <div className="hidden items-center gap-3 lg:flex">
              {recipientFieldsRemaining.length > 0 && (
                <p className="flex-shrink-0 text-shell-muted text-sm">
                  <Plural one="1 Field Remaining" other="# Fields Remaining" value={recipientFieldsRemaining.length} />
                </p>
              )}

              <div className="w-40">
                <EnvelopeSignerCompleteDialog triggerClassName={ON_BRAND_PRIMARY} />
              </div>
            </div>
          )}

          <div className="flex-shrink-0 lg:hidden">
            <MobileDropdownMenu />
          </div>
        </>
      }
    />
  );
};

/** Pílula primária sobre a faixa azul: branca com texto azul e o mesmo sulco embaixo. */
const ON_BRAND_PRIMARY =
  'bg-white text-[#1D3F94] shadow-[0_2px_0_rgba(0,0,0,0.25)] hover:bg-white/90 focus-visible:ring-white focus-visible:ring-offset-shell';

const MobileDropdownMenu = () => {
  const { envelope, recipient } = useRequiredEnvelopeSigningContext();

  const embedSigningContext = useEmbedSigningContext();

  const isEmbedSigning = embedSigningContext !== null;
  const { allowDocumentRejection } = embedSigningContext || {};

  return (
    // REVALLE: menu não modal. Os diálogos de baixar e de recusar abrem de dentro dele (o item não fecha o menu, senão
    // o diálogo desmontaria); com o menu modal, ao fechar o diálogo o menu seguia aberto e invisível com o body em
    // pointer-events: none, e o 1º toque na página se perdia.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        {/* REVALLE: h-11 (44 px de área de toque); redesign v3: contorno claro sobre a faixa azul */}
        <Button
          variant="outline"
          size="sm"
          className="h-11 border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white focus-visible:ring-white focus-visible:ring-offset-shell"
        >
          <Trans>Actions</Trans>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        <EnvelopeDownloadDialog
          envelopeId={envelope.id}
          envelopeStatus={envelope.status}
          envelopeItems={envelope.envelopeItems}
          token={recipient.token}
          trigger={
            <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
              <div>
                <DownloadCloudIcon className="mr-2 h-4 w-4" />
                <Trans>Download PDF</Trans>
              </div>
            </DropdownMenuItem>
          }
        />

        {envelope.type === EnvelopeType.DOCUMENT && allowDocumentRejection !== false && (
          <DocumentSigningRejectDialog
            documentId={mapSecondaryIdToDocumentId(envelope.secondaryId)}
            token={recipient.token}
            trigger={
              <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
                <div>
                  <BanIcon className="mr-2 h-4 w-4" />
                  <Trans>Reject</Trans>
                </div>
              </DropdownMenuItem>
            }
          />
        )}

        {!isEmbedSigning && <PublicLegalLinksDropdownMenuItems />}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
