import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import { Trans } from '@lingui/react/macro';
import { Loader } from 'lucide-react';
import { useState } from 'react';
import { Link, useRevalidator } from 'react-router';

import { GateError } from './gate-error';
import { StepHeading } from './step-heading';

export type TermStepProps = {
  token: string;
  termVersion: string;
  termText: string;
  termNotice: string;
  onDone: () => void;
};

export const TermStep = ({ token, termVersion, termText, termNotice, onDone }: TermStepProps) => {
  const [accepted, setAccepted] = useState(false);
  const [failed, setFailed] = useState(false);

  const { mutateAsync, isPending } = trpc.revalle.gate.acceptTerm.useMutation();
  const { state } = useRevalidator();
  const isBusy = isPending || state !== 'idle';

  const onSubmit = async () => {
    setFailed(false);

    try {
      await mutateAsync({ token, termVersion });
      onDone();
    } catch {
      setFailed(true);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <StepHeading>
        <Trans>Antes de assinar</Trans>
      </StepHeading>

      <div
        className="max-h-72 overflow-y-auto whitespace-pre-line rounded-md border bg-muted/30 p-4 text-base leading-relaxed"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: caixa rolável precisa de foco para quem usa teclado
        tabIndex={0}
      >
        {termText}
      </div>

      <p className="text-muted-foreground text-sm">{termNotice}</p>

      <Link
        to="/privacidade"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-11 items-center font-medium text-documenso-700 underline"
      >
        <Trans>Política de privacidade</Trans>
      </Link>

      <label htmlFor="revalle-term-accept" className="flex min-h-11 items-center gap-3 font-medium">
        <Checkbox
          id="revalle-term-accept"
          className="h-6 w-6"
          checked={accepted}
          onCheckedChange={(value) => setAccepted(value === true)}
        />
        <Trans>Li e concordo</Trans>
      </label>

      {failed && (
        <GateError>
          <Trans>Não foi possível registrar agora. Tente de novo.</Trans>
        </GateError>
      )}

      <Button
        type="button"
        size="lg"
        className="h-12 w-full text-base"
        disabled={!accepted || isBusy}
        onClick={onSubmit}
      >
        {isBusy && <Loader className="mr-2 h-5 w-5 animate-spin" />}
        <Trans>Continuar</Trans>
      </Button>
    </section>
  );
};
