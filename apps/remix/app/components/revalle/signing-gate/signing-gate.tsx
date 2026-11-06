import type { RevalleGateLoaderPayload } from '@documenso/lib/server-only/revalle/gate/get-gate-state-for-loader';
import { Trans } from '@lingui/react/macro';
import { useRevalidator } from 'react-router';

import { ConfirmStep } from './confirm-step';
import { IdentityStep } from './identity-step';
import { LockedView } from './locked-view';
import { SigningPageFrame } from './signing-band';
import { SupersededView } from './superseded-view';
import { TermStep } from './term-step';
import { UnavailableView } from './unavailable-view';

export type RevalleSigningGateProps = RevalleGateLoaderPayload;

export const RevalleSigningGate = ({ revalleGate, token, recipientName, senderName }: RevalleSigningGateProps) => {
  const { revalidate } = useRevalidator();

  const onStepDone = () => {
    void revalidate();
  };

  // Redesign v3: faixa azul com a saudação e o remetente; o passo vai num cartão só. O título do documento continua
  // fora até o portão ser passado.
  return (
    <SigningPageFrame
      as="header"
      titleAs="p"
      title={<Trans>Olá, {recipientName}</Trans>}
      subtitle={senderName ? <Trans>Documento enviado por {senderName}</Trans> : undefined}
    >
      <div className="text-base">
        {revalleGate.status === 'TERM_REQUIRED' && (
          <TermStep
            token={token}
            termVersion={revalleGate.termVersion}
            termText={revalleGate.termText}
            termNotice={revalleGate.termNotice}
            onDone={onStepDone}
          />
        )}

        {revalleGate.status === 'IDENTITY_REQUIRED' && (
          <IdentityStep token={token} attemptsLeft={revalleGate.attemptsLeft} onDone={onStepDone} />
        )}

        {revalleGate.status === 'IDENTITY_CONFIRM' && (
          <ConfirmStep token={token} preview={revalleGate.preview} onDone={onStepDone} />
        )}

        {revalleGate.status === 'LOCKED' && <LockedView />}

        {revalleGate.status === 'UNAVAILABLE' && <UnavailableView onRetry={onStepDone} />}

        {revalleGate.status === 'SUPERSEDED' && <SupersededView />}
      </div>
    </SigningPageFrame>
  );
};
