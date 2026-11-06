import { Trans } from '@lingui/react/macro';
import { LockKeyhole } from 'lucide-react';

import { GateStatusIcon } from './gate-status-icon';
import { StepHeading } from './step-heading';

export const LockedView = () => (
  <section className="flex flex-col items-center gap-5 text-center">
    <GateStatusIcon icon={LockKeyhole} tone="danger" />
    <StepHeading className="text-[20px] leading-snug sm:text-[22px]">
      <Trans>
        Este link foi bloqueado por segurança. Avisamos quem enviou o documento e a equipe de TI. Aguarde o desbloqueio
        ou peça um novo envio para outro e-mail.
      </Trans>
    </StepHeading>
  </section>
);
