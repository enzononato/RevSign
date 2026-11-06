import { cn } from '@documenso/ui/lib/utils';
import { Trans } from '@lingui/react/macro';
import { RecipientRole, SigningStatus } from '@prisma/client';
import { useMemo } from 'react';

import { type SignerSlot, SignerSlots } from '~/components/revalle/shell/signer-slots';

import { useRequiredEnvelopeSigningContext } from '../document-signing/envelope-signing-provider';

const SIGNING_ROLES: RecipientRole[] = [RecipientRole.SIGNER, RecipientRole.APPROVER];

/**
 * REVALLE (redesign v3): os encaixes de quem assina o envelope, na ordem de assinatura, com quem está assinando agora como
 * "Você". Também dá o texto da etapa da faixa ("Assinatura 3 de 3").
 */
export const useEnvelopeSignerSlots = () => {
  const { envelope, recipient } = useRequiredEnvelopeSigningContext();

  return useMemo(() => {
    const signers = envelope.recipients
      .filter((r) => SIGNING_ROLES.includes(r.role))
      .sort(
        (a, b) =>
          (a.signingOrder ?? Number.MAX_SAFE_INTEGER) - (b.signingOrder ?? Number.MAX_SAFE_INTEGER) || a.id - b.id,
      );

    const slots: SignerSlot[] = signers.map((r) => ({
      name: r.name || r.email,
      state: slotState(r.id === recipient.id, r.signingStatus),
    }));

    const signedCount = signers.filter((r) => r.signingStatus === SigningStatus.SIGNED).length;
    const isCurrentSigner =
      signers.some((r) => r.id === recipient.id) && recipient.signingStatus !== SigningStatus.SIGNED;

    return {
      slots,
      signedCount,
      totalCount: signers.length,
      // A assinatura que esta pessoa vai dar: a próxima depois das que já existem.
      position: isCurrentSigner ? Math.min(signedCount + 1, signers.length) : null,
    };
  }, [envelope.recipients, recipient.id, recipient.signingStatus]);
};

const slotState = (isYou: boolean, status: SigningStatus): SignerSlot['state'] => {
  if (isYou) {
    return 'you';
  }

  if (status === SigningStatus.SIGNED) {
    return 'signed';
  }

  if (status === SigningStatus.REJECTED) {
    return 'rejected';
  }

  return 'pending';
};

export const EnvelopeSignerSlotsBlock = ({ className }: { className?: string }) => {
  const { slots, signedCount, totalCount } = useEnvelopeSignerSlots();

  if (totalCount === 0) {
    return null;
  }

  return (
    <section className={cn(className)} aria-labelledby="revalle-signing-slots">
      <h2 id="revalle-signing-slots" className="mb-2.5 font-display font-extrabold text-[15px] tracking-[-0.01em]">
        <Trans>Signatures</Trans>
      </h2>

      <SignerSlots slots={slots} max={8} />

      <p className="mt-2 font-semibold text-[12.5px] text-muted-foreground tabular-nums">
        <Trans>
          {signedCount} of {totalCount} have signed
        </Trans>
      </p>
    </section>
  );
};
