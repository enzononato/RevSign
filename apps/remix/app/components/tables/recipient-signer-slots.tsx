import { cn } from '@documenso/ui/lib/utils';
import { Plural, Trans } from '@lingui/react/macro';
import { DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';

import { type SignerSlot, SignerSlots } from '~/components/revalle/shell/signer-slots';

export type SlotRecipient = {
  name: string;
  email: string;
  role: RecipientRole;
  signingStatus: SigningStatus;
};

/** Quem só recebe cópia ou só visualiza não assina: fica fora dos encaixes. */
export const isSlotRecipient = (recipient: SlotRecipient) =>
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
  /** REVALLE: quantos encaixes mostrar antes do "+N" (padrão do SignerSlots: 6). */
  max?: number;
  /**
   * REVALLE v3 (listas): a linha curta também cobre rascunho ("Rascunho") e recusa ("Fulano recusou"), porque o cartão
   * da lista não tem mais a pílula de status.
   */
  withStatusSummary?: boolean;
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
  max,
  withStatusSummary = false,
  className,
}: RecipientSignerSlotsProps) => {
  const slots = toSignerSlots(recipients, currentUserEmail);

  if (slots.length === 0) {
    return <span className={cn('text-muted-foreground text-sm', className)}>-</span>;
  }

  const missing = slots.filter((slot) => slot.state === 'pending' || slot.state === 'you').length;

  return (
    <div className={cn('min-w-0', className)}>
      <SignerSlots slots={slots} size={size} max={max} />

      {withSummary && (
        <SignerSummary
          recipients={recipients}
          documentStatus={documentStatus}
          missing={missing}
          withStatusSummary={withStatusSummary}
        />
      )}
    </div>
  );
};

type SignerSummaryProps = {
  recipients: SlotRecipient[];
  documentStatus: DocumentStatus;
  missing: number;
  withStatusSummary: boolean;
};

const SignerSummary = ({ recipients, documentStatus, missing, withStatusSummary }: SignerSummaryProps) => {
  const rejecter = recipients.find((recipient) => recipient.signingStatus === SigningStatus.REJECTED);

  const summary = (() => {
    if (documentStatus === DocumentStatus.PENDING) {
      // REVALLE v3 (finish review 1, #4): todos os que assinam já assinaram, mas o documento ainda não fechou (cópia,
      // selagem, Financeiro). "Todos assinaram" ao lado de "Pendente" parecia contradição: diga a espera de verdade.
      if (missing === 0) {
        return <Trans>Waiting for completion</Trans>;
      }

      return <Plural value={missing} one="# signature missing" other="# signatures missing" />;
    }

    if (documentStatus === DocumentStatus.COMPLETED) {
      return <Trans>Everyone signed</Trans>;
    }

    if (!withStatusSummary) {
      return null;
    }

    if (documentStatus === DocumentStatus.DRAFT) {
      return <Trans>Draft</Trans>;
    }

    if (documentStatus === DocumentStatus.REJECTED && rejecter) {
      const name = rejecter.name.trim().split(/\s+/)[0] || rejecter.email.split('@')[0];

      return <Trans>{name} rejected</Trans>;
    }

    return null;
  })();

  if (!summary) {
    return null;
  }

  return <p className="mt-1 font-semibold text-[12.5px] text-muted-foreground">{summary}</p>;
};
