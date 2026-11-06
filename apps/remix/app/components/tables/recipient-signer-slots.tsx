import { cn } from '@documenso/ui/lib/utils';
import { Plural, Trans } from '@lingui/react/macro';
import { DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';

import { type SignerSlot, SignerSlots } from '~/components/revalle/shell/signer-slots';

type SlotRecipient = {
  name: string;
  email: string;
  role: RecipientRole;
  signingStatus: SigningStatus;
};

/** Quem só recebe cópia ou só visualiza não assina: fica fora dos encaixes. */
const isSlotRecipient = (recipient: SlotRecipient) =>
  recipient.role !== RecipientRole.CC && recipient.role !== RecipientRole.VIEWER;

export const toSignerSlots = (recipients: SlotRecipient[], currentUserEmail?: string): SignerSlot[] =>
  recipients.filter(isSlotRecipient).map((recipient) => {
    const name = recipient.name?.trim() || recipient.email;

    if (recipient.signingStatus === SigningStatus.SIGNED) {
      return { name, state: 'signed' };
    }

    if (recipient.signingStatus === SigningStatus.REJECTED) {
      return { name, state: 'rejected' };
    }

    const isCurrentUser =
      currentUserEmail !== undefined && recipient.email.toLowerCase() === currentUserEmail.toLowerCase();

    return { name, state: isCurrentUser ? 'you' : 'pending' };
  });

export type RecipientSignerSlotsProps = {
  recipients: SlotRecipient[];
  documentStatus: DocumentStatus;
  currentUserEmail?: string;
  /** Linha curta embaixo dos encaixes ("Falta 1 assinatura", "Todos assinaram"). */
  withSummary?: boolean;
  size?: 'sm' | 'md';
  className?: string;
};

/**
 * REVALLE v3: os encaixes de quem assina (cheio = assinou, vazado = falta, riscado = recusou) no lugar da pilha de
 * avatares das listas. CC e quem só visualiza ficam de fora.
 */
export const RecipientSignerSlots = ({
  recipients,
  documentStatus,
  currentUserEmail,
  withSummary = true,
  size = 'md',
  className,
}: RecipientSignerSlotsProps) => {
  const slots = toSignerSlots(recipients, currentUserEmail);

  if (slots.length === 0) {
    return <span className={cn('text-muted-foreground text-sm', className)}>-</span>;
  }

  const missing = slots.filter((slot) => slot.state === 'pending' || slot.state === 'you').length;

  return (
    <div className={cn('min-w-0', className)}>
      <SignerSlots slots={slots} size={size} />

      {withSummary && documentStatus === DocumentStatus.PENDING && missing > 0 && (
        <p className="mt-1 font-semibold text-[12.5px] text-muted-foreground">
          <Plural value={missing} one="# signature missing" other="# signatures missing" />
        </p>
      )}

      {withSummary &&
        (documentStatus === DocumentStatus.COMPLETED ||
          (documentStatus === DocumentStatus.PENDING && missing === 0)) && (
          <p className="mt-1 font-semibold text-[12.5px] text-muted-foreground">
            <Trans>Everyone signed</Trans>
          </p>
        )}
    </div>
  );
};
