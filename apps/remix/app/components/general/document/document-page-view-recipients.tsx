import { useSession } from '@documenso/lib/client-only/providers/session';
import { RECIPIENT_ROLES_DESCRIPTION } from '@documenso/lib/constants/recipient-roles';
import type { TEnvelope } from '@documenso/lib/types/envelope';
import { isDocumentCompleted } from '@documenso/lib/utils/document';
import { formatSigningLink, isRecipientExpired } from '@documenso/lib/utils/recipients';
import { CopyTextButton } from '@documenso/ui/components/common/copy-text-button';
import { SignatureIcon } from '@documenso/ui/icons/signature';
import { Badge } from '@documenso/ui/primitives/badge';
import { PopoverHover } from '@documenso/ui/primitives/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@documenso/ui/primitives/tooltip';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';
import { TooltipArrow } from '@radix-ui/react-tooltip';
import {
  AlertTriangle,
  CheckIcon,
  Clock,
  Clock8Icon,
  MailIcon,
  MailOpenIcon,
  PenIcon,
  PlusIcon,
  UserIcon,
} from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { match } from 'ts-pattern';

import { RecipientSignerSlots, toSignerSlots } from '~/components/tables/recipient-signer-slots';

export type DocumentPageViewRecipientsProps = {
  envelope: TEnvelope;
  documentRootPath: string;
};

export const DocumentPageViewRecipients = ({ envelope, documentRootPath }: DocumentPageViewRecipientsProps) => {
  const { _, i18n } = useLingui();
  const { user } = useSession();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const recipients = envelope.recipients;
  const [shouldHighlightCopyButtons, setShouldHighlightCopyButtons] = useState(false);

  // Check for action=view-tokens query parameter and set highlighting state
  useEffect(() => {
    const hasViewTokensAction = searchParams.get('action') === 'copy-links';

    if (hasViewTokensAction) {
      setShouldHighlightCopyButtons(true);

      // Remove the query parameter immediately
      const params = new URLSearchParams(searchParams);
      params.delete('action');
      setSearchParams(params);
    }
  }, [searchParams, setSearchParams]);

  return (
    // REVALLE v3: cartão macio com os encaixes de quem assina em cima e a situação de cada um em pílula
    <section className="flex flex-col rounded-card bg-card shadow-card dark:shadow-[0_0_0_1px_hsl(var(--border))]">
      <div className="flex flex-row items-center justify-between px-5 pt-4 pb-3">
        <h2 className="font-display font-extrabold text-[17px] text-foreground">
          <Trans>Recipients</Trans>
        </h2>

        {!isDocumentCompleted(envelope.status) && (
          <Link
            to={`${documentRootPath}/${envelope.id}/edit?step=signers`}
            title={_(msg`Modify recipients`)}
            aria-label={_(msg`Modify recipients`)}
            className="-mr-2 inline-flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            {recipients.length === 0 ? <PlusIcon className="h-4 w-4" /> : <PenIcon className="h-3.5 w-3.5" />}
          </Link>
        )}
      </div>

      {envelope.status !== DocumentStatus.DRAFT && toSignerSlots(recipients, user.email).length > 0 && (
        <div className="px-5 pb-4">
          <RecipientSignerSlots
            recipients={recipients}
            documentStatus={envelope.status}
            currentUserEmail={user.email}
          />
        </div>
      )}

      <ul className="divide-y border-t text-muted-foreground">
        {recipients.length === 0 && (
          <li className="flex flex-col items-center justify-center py-6 text-sm">
            <Trans>No recipients</Trans>
          </li>
        )}

        {recipients.map((recipient, i) => (
          <li key={recipient.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
            <div className="min-w-0">
              <p className="break-words font-semibold text-foreground">{recipient.name || recipient.email}</p>
              <p className="break-all text-muted-foreground text-xs">
                {recipient.name ? `${recipient.email} · ` : ''}
                {_(RECIPIENT_ROLES_DESCRIPTION[recipient.role].roleName)}
              </p>
            </div>

            <div className="flex shrink-0 flex-row items-center gap-1">
              {envelope.status !== DocumentStatus.DRAFT && recipient.signingStatus === SigningStatus.SIGNED && (
                <Badge variant="default">
                  {match(recipient.role)
                    .with(RecipientRole.APPROVER, () => (
                      <>
                        <CheckIcon className="mr-1 h-3 w-3" />
                        <Trans>Approved</Trans>
                      </>
                    ))
                    .with(RecipientRole.CC, () =>
                      envelope.status === DocumentStatus.COMPLETED ? (
                        <>
                          <MailIcon className="mr-1 h-3 w-3" />
                          <Trans>Sent</Trans>
                        </>
                      ) : (
                        <>
                          <CheckIcon className="mr-1 h-3 w-3" />
                          <Trans>Ready</Trans>
                        </>
                      ),
                    )

                    .with(RecipientRole.SIGNER, () => (
                      <>
                        <SignatureIcon className="mr-1 h-3 w-3" />
                        <Trans>Signed</Trans>
                      </>
                    ))
                    .with(RecipientRole.VIEWER, () => (
                      <>
                        <MailOpenIcon className="mr-1 h-3 w-3" />
                        <Trans>Viewed</Trans>
                      </>
                    ))
                    .with(RecipientRole.ASSISTANT, () => (
                      <>
                        <UserIcon className="mr-1 h-3 w-3" />
                        <Trans>Assisted</Trans>
                      </>
                    ))
                    .exhaustive()}
                </Badge>
              )}

              {envelope.status !== DocumentStatus.DRAFT &&
                recipient.signingStatus === SigningStatus.NOT_SIGNED &&
                isRecipientExpired(recipient) && (
                  <Badge variant="destructive">
                    <Clock8Icon className="mr-1 h-3 w-3" />
                    <Trans>Expired</Trans>
                  </Badge>
                )}

              {envelope.status !== DocumentStatus.DRAFT &&
                recipient.signingStatus === SigningStatus.NOT_SIGNED &&
                !isRecipientExpired(recipient) &&
                (recipient.expiresAt ? (
                  <PopoverHover
                    trigger={
                      <Badge variant="warning">
                        <Clock className="mr-1 h-3 w-3" />
                        <Trans>Pending</Trans>
                      </Badge>
                    }
                  >
                    <p className="text-muted-foreground text-xs">
                      <Trans>
                        Expires {recipient.expiresAt ? i18n.date(recipient.expiresAt, DateTime.DATETIME_MED) : 'N/A'}
                      </Trans>
                    </p>
                  </PopoverHover>
                ) : (
                  <Badge variant="warning">
                    <Clock className="mr-1 h-3 w-3" />
                    <Trans>Pending</Trans>
                  </Badge>
                ))}

              {envelope.status !== DocumentStatus.DRAFT && recipient.signingStatus === SigningStatus.REJECTED && (
                <PopoverHover
                  trigger={
                    <Badge variant="destructive">
                      <AlertTriangle className="mr-1 h-3 w-3" />
                      <Trans>Rejected</Trans>
                    </Badge>
                  }
                >
                  <p className="text-sm">
                    <Trans>Reason for rejection: </Trans>
                  </p>

                  <p className="mt-1 text-muted-foreground text-sm">{recipient.rejectionReason}</p>
                </PopoverHover>
              )}

              {envelope.status === DocumentStatus.PENDING &&
                recipient.signingStatus === SigningStatus.NOT_SIGNED &&
                recipient.role !== RecipientRole.CC &&
                !isRecipientExpired(recipient) && (
                  <TooltipProvider>
                    <Tooltip open={shouldHighlightCopyButtons && i === 0}>
                      <TooltipTrigger asChild>
                        <div
                          className={shouldHighlightCopyButtons ? 'animate-pulse' : ''}
                          onClick={() => setShouldHighlightCopyButtons(false)}
                        >
                          <CopyTextButton
                            value={formatSigningLink(recipient.token)}
                            onCopySuccess={() => {
                              toast({
                                title: _(msg`Copied to clipboard`),
                                description: _(msg`The signing link has been copied to your clipboard.`),
                              });
                              setShouldHighlightCopyButtons(false);
                            }}
                          />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent sideOffset={2}>
                        <Trans>Copy Signing Links</Trans>
                        <TooltipArrow className="fill-background" />
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};
