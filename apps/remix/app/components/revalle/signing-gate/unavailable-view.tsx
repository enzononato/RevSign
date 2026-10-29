import { Button } from '@documenso/ui/primitives/button';
import { Trans } from '@lingui/react/macro';
import { CloudOff } from 'lucide-react';
import { useRevalidator } from 'react-router';

import { StepHeading } from './step-heading';

export const UnavailableView = ({ onRetry }: { onRetry: () => void }) => {
  const { state } = useRevalidator();

  return (
    <section className="flex flex-col items-center gap-4 text-center">
      <CloudOff className="h-12 w-12 text-muted-foreground" />
      <StepHeading>
        <Trans>Não foi possível confirmar agora. Tente novamente em alguns minutos.</Trans>
      </StepHeading>
      <Button type="button" size="lg" className="h-12 w-full text-base" disabled={state !== 'idle'} onClick={onRetry}>
        <Trans>Tentar de novo</Trans>
      </Button>
    </section>
  );
};
