import { Trans } from '@lingui/react/macro';
import { LockKeyhole } from 'lucide-react';

import { StepHeading } from './step-heading';

export const LockedView = () => (
  <section className="flex flex-col items-center gap-4 text-center">
    <LockKeyhole className="h-12 w-12 text-destructive" />
    <StepHeading>
      <Trans>
        Este link foi bloqueado por segurança. Avisamos quem enviou o documento e o TI. Aguarde o desbloqueio ou peça um
        novo envio para outro e-mail.
      </Trans>
    </StepHeading>
  </section>
);
