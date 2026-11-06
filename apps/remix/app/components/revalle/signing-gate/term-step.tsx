import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import { Trans } from '@lingui/react/macro';
import { ExternalLinkIcon } from 'lucide-react';
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
        className="max-h-72 overflow-y-auto whitespace-pre-line rounded-[13px] bg-background px-4 py-3.5 text-[15px] leading-relaxed shadow-[inset_0_0_0_1px_hsl(var(--border))]"
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
        className="inline-flex min-h-11 items-center gap-1.5 self-start font-bold text-brand-text underline-offset-4 hover:underline"
      >
        <Trans>Política de privacidade</Trans>
        <ExternalLinkIcon aria-hidden className="h-4 w-4" />
      </Link>

      <label
        htmlFor="revalle-term-accept"
        className="flex min-h-[52px] cursor-pointer items-center gap-3 rounded-[13px] px-3.5 font-semibold shadow-[inset_0_0_0_1.5px_hsl(var(--border))] has-[[data-state=checked]]:bg-accent has-[[data-state=checked]]:shadow-[inset_0_0_0_1.5px_hsl(var(--primary))]"
      >
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

      <Button type="button" size="lg" className="w-full" disabled={!accepted} loading={isBusy} onClick={onSubmit}>
        <Trans>Continuar</Trans>
      </Button>
    </section>
  );
};
