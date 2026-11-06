import { useSession } from '@documenso/lib/client-only/providers/session';
import type { TEnvelope } from '@documenso/lib/types/envelope';
import { isDocumentCompleted } from '@documenso/lib/utils/document';
import { getEnvelopeItemPermissions } from '@documenso/lib/utils/envelope';
import { formatDocumentsPath } from '@documenso/lib/utils/teams';
import { trpc as trpcReact } from '@documenso/trpc/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@documenso/ui/primitives/dropdown-menu';
import { Trans, useLingui } from '@lingui/react/macro';
import { DocumentStatus, EnvelopeType } from '@prisma/client';
import { Copy, Download, Edit, History, MoreHorizontal, Pencil, ScrollTextIcon, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { EnvelopeDeleteDialog } from '~/components/dialogs/envelope-delete-dialog';
import { EnvelopeDownloadDialog } from '~/components/dialogs/envelope-download-dialog';
import { EnvelopeDuplicateDialog } from '~/components/dialogs/envelope-duplicate-dialog';
import { EnvelopeRedistributeDialog } from '~/components/dialogs/envelope-redistribute-dialog';
import { EnvelopeRenameDialog } from '~/components/dialogs/envelope-rename-dialog';
import { DocumentRecipientLinkCopyDialog } from '~/components/general/document/document-recipient-link-copy-dialog';
import { useCurrentTeam } from '~/providers/team';

export type DocumentPageViewDropdownProps = {
  envelope: TEnvelope;
};

export const DocumentPageViewDropdown = ({ envelope }: DocumentPageViewDropdownProps) => {
  const { user } = useSession();
  const { t } = useLingui();

  const navigate = useNavigate();
  const team = useCurrentTeam();

  const trpcUtils = trpcReact.useUtils();

  const [isRenameDialogOpen, setRenameDialogOpen] = useState(false);

  const recipient = envelope.recipients.find((recipient) => recipient.email === user.email);

  const isOwner = envelope.userId === user.id;
  const isPending = envelope.status === DocumentStatus.PENDING;
  const isDeleted = envelope.deletedAt !== null;
  const isComplete = isDocumentCompleted(envelope);
  const isCurrentTeamDocument = team && envelope.teamId === team.id;
  const canManageDocument = Boolean(isOwner || isCurrentTeamDocument);

  const { canTitleBeChanged } = getEnvelopeItemPermissions(envelope, []);

  const documentsPath = formatDocumentsPath(team.url);

  return (
    <DropdownMenu>
      {/* REVALLE v3: botão redondo de contorno (44px) ao lado da ação principal no cabeçalho */}
      <DropdownMenuTrigger
        data-testid="document-page-view-action-btn"
        aria-label={t`Actions`}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-[1.5px] border-border bg-card text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <MoreHorizontal className="h-5 w-5" />
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-52" align="end" forceMount>
        <DropdownMenuLabel>
          <Trans>Action</Trans>
        </DropdownMenuLabel>

        {(isOwner || isCurrentTeamDocument) && !isComplete && (
          <DropdownMenuItem asChild>
            <Link to={`${documentsPath}/${envelope.id}/edit`}>
              <Edit className="mr-2 h-4 w-4" />
              <Trans>Edit</Trans>
            </Link>
          </DropdownMenuItem>
        )}

        {canManageDocument && canTitleBeChanged && (
          <DropdownMenuItem onClick={() => setRenameDialogOpen(true)}>
            <Pencil className="mr-2 h-4 w-4" />
            <Trans>Rename</Trans>
          </DropdownMenuItem>
        )}

        <EnvelopeDownloadDialog
          envelopeId={envelope.id}
          envelopeStatus={envelope.status}
          isLegacy={envelope.internalVersion === 1}
          token={canManageDocument ? undefined : recipient?.token}
          envelopeItems={envelope.envelopeItems}
          trigger={
            <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
              <div>
                <Download className="mr-2 h-4 w-4" />
                <Trans>Download</Trans>
              </div>
            </DropdownMenuItem>
          }
        />

        <DropdownMenuItem asChild>
          <Link to={`${documentsPath}/${envelope.id}/logs`}>
            <ScrollTextIcon className="mr-2 h-4 w-4" />
            <Trans>Audit Logs</Trans>
          </Link>
        </DropdownMenuItem>

        <EnvelopeDuplicateDialog
          envelopeId={envelope.id}
          envelopeType={EnvelopeType.DOCUMENT}
          trigger={
            <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
              <div>
                <Copy className="mr-2 h-4 w-4" />
                <Trans>Duplicate</Trans>
              </div>
            </DropdownMenuItem>
          }
        />

        {/* REVALLE: "Salvar como modelo" saiu (Modelos saem da tela, Fase 7, spec §6). */}

        <EnvelopeDeleteDialog
          id={envelope.id}
          type={EnvelopeType.DOCUMENT}
          status={envelope.status}
          title={envelope.title}
          canManageDocument={canManageDocument}
          onDelete={() => {
            void navigate(documentsPath);
          }}
          trigger={
            <DropdownMenuItem asChild disabled={isDeleted} onSelect={(e) => e.preventDefault()}>
              <div>
                <Trash2 className="mr-2 h-4 w-4" />
                <Trans>Delete</Trans>
              </div>
            </DropdownMenuItem>
          }
        />

        <DropdownMenuLabel>
          <Trans>Share</Trans>
        </DropdownMenuLabel>

        {canManageDocument && (
          <DocumentRecipientLinkCopyDialog
            recipients={envelope.recipients}
            trigger={
              <DropdownMenuItem disabled={!isPending || isDeleted} onSelect={(e) => e.preventDefault()}>
                <Copy className="mr-2 h-4 w-4" />
                <Trans>Signing Links</Trans>
              </DropdownMenuItem>
            }
          />
        )}

        {canManageDocument && (
          <EnvelopeRedistributeDialog
            envelope={envelope}
            envelopeType={EnvelopeType.DOCUMENT}
            trigger={
              <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
                <div>
                  <History className="mr-2 h-4 w-4" />
                  <Trans>Resend</Trans>
                </div>
              </DropdownMenuItem>
            }
          />
        )}

        {/* REVALLE: sem "Share Signing Card" (link público e cartão para X/Twitter): documento interno não vai para rede social */}
      </DropdownMenuContent>

      <EnvelopeRenameDialog
        id={envelope.id}
        initialTitle={envelope.title}
        open={isRenameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        onSuccess={async () => {
          await trpcUtils.envelope.get.invalidate();
        }}
      />
    </DropdownMenu>
  );
};
