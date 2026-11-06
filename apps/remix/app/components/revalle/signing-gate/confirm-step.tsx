import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { Trans } from '@lingui/react/macro';
import { UserRoundCheckIcon } from 'lucide-react';
import { useState } from 'react';
import { useRevalidator } from 'react-router';

import { GateError } from './gate-error';
import { GateStatusIcon } from './gate-status-icon';
import { StepHeading } from './step-heading';

export type ConfirmStepProps = {
  token: string;
  preview: { primeiroNome: string; cargo: string | null; unidade: string | null };
  onDone: () => void;
};

export const ConfirmStep = ({ token, preview, onDone }: ConfirmStepProps) => {
  const [failed, setFailed] = useState(false);

  const { mutateAsync, isPending } = trpc.revalle.gate.confirmIdentity.useMutation();
  const { state } = useRevalidator();
  const isBusy = isPending || state !== 'idle';

  const answer = async (isMe: boolean) => {
    setFailed(false);

    try {
      await mutateAsync({ token, isMe });
      onDone();
    } catch {
      setFailed(true);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <GateStatusIcon icon={UserRoundCheckIcon} tone="brand" />

      {/* Redesign v3: mesmo texto da pergunta; só a apresentação mudou. */}
      <StepHeading>
        <Trans>Você é</Trans> <strong className="font-black text-brand-text">{preview.primeiroNome}</strong>
        {preview.cargo && <em className="font-bold text-muted-foreground not-italic">, {preview.cargo}</em>}
        {preview.unidade && <em className="font-bold text-muted-foreground not-italic">, {preview.unidade}</em>}?
      </StepHeading>

      {failed && (
        <GateError>
          <Trans>Não foi possível registrar agora. Tente de novo.</Trans>
        </GateError>
      )}

      <Button type="button" size="lg" className="mt-1 w-full" loading={isBusy} onClick={() => answer(true)}>
        <Trans>Sim, sou eu</Trans>
      </Button>

      <Button
        type="button"
        variant="outline"
        size="lg"
        className="w-full"
        disabled={isBusy}
        onClick={() => answer(false)}
      >
        <Trans>Não sou eu</Trans>
      </Button>
    </section>
  );
};
