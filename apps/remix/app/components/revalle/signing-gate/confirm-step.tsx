import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { Trans } from '@lingui/react/macro';
import { Loader } from 'lucide-react';
import { useState } from 'react';

import { GateError } from './gate-error';

export type ConfirmStepProps = {
  token: string;
  preview: { primeiroNome: string; cargo: string | null; unidade: string | null };
  onDone: () => void;
};

export const ConfirmStep = ({ token, preview, onDone }: ConfirmStepProps) => {
  const [failed, setFailed] = useState(false);

  const { mutateAsync, isPending } = trpc.revalle.gate.confirmIdentity.useMutation();

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
      <h1 className="font-bold text-2xl leading-snug">
        <Trans>Você é</Trans> <strong>{preview.primeiroNome}</strong>
        {preview.cargo && <em>, {preview.cargo}</em>}
        {preview.unidade && <em>, {preview.unidade}</em>}?
      </h1>

      {failed && (
        <GateError>
          <Trans>Não foi possível registrar agora. Tente de novo.</Trans>
        </GateError>
      )}

      <Button
        type="button"
        size="lg"
        className="h-12 w-full text-base"
        disabled={isPending}
        onClick={() => answer(true)}
      >
        {isPending && <Loader className="mr-2 h-5 w-5 animate-spin" />}
        <Trans>Sim, sou eu</Trans>
      </Button>

      <Button
        type="button"
        variant="outline"
        size="lg"
        className="h-12 w-full text-base"
        disabled={isPending}
        onClick={() => answer(false)}
      >
        <Trans>Não sou eu</Trans>
      </Button>
    </section>
  );
};
