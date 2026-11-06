import { Button } from '@documenso/ui/primitives/button';
import { Trans } from '@lingui/react/macro';
import { CloudOff } from 'lucide-react';
import { useRevalidator } from 'react-router';

import { GateStatusIcon } from './gate-status-icon';
import { StepHeading } from './step-heading';

export const UnavailableView = ({ onRetry }: { onRetry: () => void }) => {
  const { state } = useRevalidator();

  return (
    <section className="flex flex-col items-center gap-5 text-center">
      <GateStatusIcon icon={CloudOff} tone="neutral" />
      <StepHeading className="text-[20px] leading-snug sm:text-[22px]">
        <Trans>Não foi possível confirmar agora. Tente novamente em alguns minutos.</Trans>
      </StepHeading>
      <Button type="button" size="lg" className="w-full" loading={state !== 'idle'} onClick={onRetry}>
        <Trans>Tentar de novo</Trans>
      </Button>
    </section>
  );
};
