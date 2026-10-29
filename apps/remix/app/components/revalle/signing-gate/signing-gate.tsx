import type { RevalleGateLoaderPayload } from '@documenso/lib/server-only/revalle/gate/get-gate-state-for-loader';
import { Trans } from '@lingui/react/macro';
import { useRevalidator } from 'react-router';

import { ConfirmStep } from './confirm-step';
import { IdentityStep } from './identity-step';
import { LockedView } from './locked-view';
import { TermStep } from './term-step';
import { UnavailableView } from './unavailable-view';

export type RevalleSigningGateProps = RevalleGateLoaderPayload;

export const RevalleSigningGate = ({ revalleGate, token, recipientName, senderName }: RevalleSigningGateProps) => {
  const { revalidate } = useRevalidator();

  const onStepDone = () => {
    void revalidate();
  };

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-lg flex-col gap-6 px-4 py-8 text-base">
      <header className="space-y-1">
        <p className="font-medium text-lg">
          <Trans>Olá, {recipientName}</Trans>
        </p>
        {senderName && (
          <p className="text-muted-foreground">
            <Trans>Documento enviado por {senderName}</Trans>
          </p>
        )}
      </header>

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
    </main>
  );
};
