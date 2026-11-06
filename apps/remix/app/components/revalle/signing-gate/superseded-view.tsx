import { Trans } from '@lingui/react/macro';
import { FileXIcon } from 'lucide-react';

import { GateStatusIcon } from './gate-status-icon';
import { StepHeading } from './step-heading';

export const SupersededView = () => (
  <section className="flex flex-col items-center gap-4 text-center">
    <GateStatusIcon icon={FileXIcon} tone="neutral" />
    <StepHeading>
      <Trans>Este documento foi substituído por uma nova versão.</Trans>
    </StepHeading>
    <p className="text-muted-foreground">
      <Trans>O convite da nova versão chega por e-mail.</Trans>
    </p>
  </section>
);
