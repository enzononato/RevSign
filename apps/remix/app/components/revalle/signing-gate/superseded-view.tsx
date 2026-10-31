import { Trans } from '@lingui/react/macro';
import { FileXIcon } from 'lucide-react';

import { StepHeading } from './step-heading';

export const SupersededView = () => (
  <section className="flex flex-col items-center gap-4 text-center">
    <FileXIcon className="h-12 w-12 text-muted-foreground" />
    <StepHeading>
      <Trans>Este documento foi substituído por uma nova versão (conta contábil alterada).</Trans>
    </StepHeading>
    <p className="text-muted-foreground">
      <Trans>O convite da nova versão chega por e-mail.</Trans>
    </p>
  </section>
);
