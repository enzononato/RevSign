import { useSession } from '@documenso/lib/client-only/providers/session';
import type { TDocumentMany as TDocumentRow } from '@documenso/lib/types/document';
import { isDocumentCompleted } from '@documenso/lib/utils/document';
import { findRecipientByEmail } from '@documenso/lib/utils/recipients';
import { formatDocumentsPath } from '@documenso/lib/utils/teams';
import { Button } from '@documenso/ui/primitives/button';
import { Trans } from '@lingui/react/macro';
import { DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';
import { CheckCircle, Download, Edit, EyeIcon, Pencil } from 'lucide-react';
import { Link } from 'react-router';
import { match } from 'ts-pattern';

import { useCurrentTeam } from '~/providers/team';

import { EnvelopeDownloadDialog } from '../dialogs/envelope-download-dialog';

export type DocumentsTableActionButtonProps = {
  row: TDocumentRow;
};

export const DocumentsTableActionButton = ({ row }: DocumentsTableActionButtonProps) => {
  const { user } = useSession();

  const team = useCurrentTeam();

  const recipient = findRecipientByEmail({
    recipients: row.recipients,
    userEmail: user.email,
    teamEmail: team.teamEmail?.email,
  });

  const isOwner = row.user.id === user.id;
  const isRecipient = !!recipient;
  const isDraft = row.status === DocumentStatus.DRAFT;
  const isPending = row.status === DocumentStatus.PENDING;
  const isComplete = isDocumentCompleted(row.status);
  const isSigned = recipient?.signingStatus === SigningStatus.SIGNED;
  const role = recipient?.role;
  const isCurrentTeamDocument = team && row.team?.url === team.url;

  const documentsPath = formatDocumentsPath(team.url);
  const formatPath = `${documentsPath}/${row.envelopeId}/edit`;

  // TODO: Consider if want to keep this logic for hiding viewing for CC'ers
  if (recipient?.role === RecipientRole.CC && isComplete === false) {
    return null;
  }

  // REVALLE: depois de assinar, o botão "View" continua ativo (a nota fiscal pode esperar dias o Financeiro): abre a página
  // do documento para quem o tem no próprio time e a página de conclusão para quem só recebeu.
  return (
    match({
      isOwner,
      isRecipient,
      isDraft,
      isPending,
      isComplete,
      isSigned,
      isCurrentTeamDocument,
      internalVersion: row.internalVersion,
    })
      .with(isOwner ? { isDraft: true, isOwner: true } : { isDraft: true, isCurrentTeamDocument: true }, () => (
        <Button className="min-w-[8rem]" asChild>
          <Link to={formatPath}>
            <Edit className="mr-2 -ml-1 h-4 w-4" />
            <Trans>Edit</Trans>
          </Link>
        </Button>
      ))
      .with({ isRecipient: true, isPending: true, isSigned: false }, () => (
        <Button className="min-w-[8rem]" asChild>
          <a href={`/sign/${recipient?.token}`}>
            {match(role)
              .with(RecipientRole.SIGNER, () => (
                <>
                  <Pencil className="mr-2 -ml-1 h-4 w-4" />
                  <Trans>Sign</Trans>
                </>
              ))
              .with(RecipientRole.APPROVER, () => (
                <>
                  <CheckCircle className="mr-2 -ml-1 h-4 w-4" />
                  <Trans>Approve</Trans>
                </>
              ))
              .otherwise(() => (
                <>
                  <EyeIcon className="mr-2 -ml-1 h-4 w-4" />
                  <Trans>View</Trans>
                </>
              ))}
          </a>
        </Button>
      ))
      // REVALLE v3: só a ação principal (editar, assinar) é azul; ver e baixar ficam em contorno
      .with({ isPending: true, isSigned: true }, () => (
        <Button variant="outline" className="min-w-[8rem]" asChild>
          {isCurrentTeamDocument ? (
            <Link to={`${documentsPath}/${row.envelopeId}`}>
              <EyeIcon className="mr-2 -ml-1 h-4 w-4" />
              <Trans>View</Trans>
            </Link>
          ) : (
            <a href={`/sign/${recipient?.token}`}>
              <EyeIcon className="mr-2 -ml-1 h-4 w-4" />
              <Trans>View</Trans>
            </a>
          )}
        </Button>
      ))
      .with({ isComplete: true }, () => (
        <EnvelopeDownloadDialog
          envelopeId={row.envelopeId}
          envelopeStatus={row.status}
          token={recipient?.token}
          trigger={
            <Button variant="outline" className="min-w-[8rem]">
              <Download className="mr-2 -ml-1 inline h-4 w-4" />
              <Trans>Download</Trans>
            </Button>
          }
        />
      ))
      .otherwise(() => null)
  );
};
