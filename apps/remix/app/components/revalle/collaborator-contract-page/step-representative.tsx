import { useSession } from '@documenso/lib/client-only/providers/session';
import { TrpcProvider, trpc } from '@documenso/trpc/react';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useId, useMemo, useState } from 'react';

// REVALLE (v.22): passo 2 do assistente: o e-mail de quem assina pela empresa, com a dica "Conta: {nome}".

const COMPLETE_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type StepRepresentativeProps = {
  email: string;
  onEmailChange: (email: string) => void;
  error: string | null;
  /** O nome da conta do e-mail, para o resumo do último passo. */
  onAccountName: (name: string | null) => void;
};

export const StepRepresentative = ({ email, onEmailChange, error, onAccountName }: StepRepresentativeProps) => {
  const { t } = useLingui();

  const inputId = useId();
  const { organisations } = useSession();

  // A consulta do nome da conta pede um time (cabeçalho x-team-id): qualquer time de quem está montando serve.
  const teamId = organisations.flatMap((organisation) => organisation.teams)[0]?.id;
  const headers = useMemo(() => (teamId ? { 'x-team-id': String(teamId) } : undefined), [teamId]);

  return (
    <div className="flex max-w-xl flex-col gap-1.5" data-testid="wizard-step-representative">
      <Label htmlFor={inputId}>
        <Trans>E-mail do representante</Trans>
      </Label>
      <Input
        id={inputId}
        type="email"
        inputMode="email"
        autoComplete="off"
        spellCheck={false}
        value={email}
        maxLength={254}
        placeholder={t`nome@revalle.com.br`}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${inputId}-help${error ? ` ${inputId}-error` : ''}`}
        onChange={(event) => onEmailChange(event.target.value)}
        data-testid="representative-email"
      />

      {headers && (
        <TrpcProvider headers={headers}>
          <AccountHint email={email} onAccountName={onAccountName} />
        </TrpcProvider>
      )}

      {error && (
        <p id={`${inputId}-error`} className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}

      <p id={`${inputId}-help`} className="mt-2 rounded-xl bg-muted/60 p-4 text-muted-foreground text-sm">
        <Trans>
          O representante recebe o contrato primeiro. Assim que ele assinar, o envio para os colaboradores começa
          sozinho.
        </Trans>
      </p>
    </div>
  );
};

/** "Conta: {nome}" quando o e-mail digitado já tem conta (espera a pessoa parar de digitar). */
const AccountHint = ({ email, onAccountName }: { email: string; onAccountName: (name: string | null) => void }) => {
  const { t } = useLingui();

  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const normalized = email.trim().toLowerCase();
    const timer = setTimeout(() => setDebounced(normalized), 400);

    return () => clearTimeout(timer);
  }, [email]);

  const isCurrent = debounced === email.trim().toLowerCase();
  const isComplete = COMPLETE_EMAIL.test(debounced);

  const { data } = trpc.revalle.recipients.accountName.useQuery(
    { email: debounced },
    { enabled: isComplete, retry: false, staleTime: 60_000 },
  );

  const name = isCurrent && isComplete ? (data?.name ?? null) : null;

  useEffect(() => {
    onAccountName(name);
  }, [name]);

  if (!name) {
    return null;
  }

  return (
    <p className="text-muted-foreground text-sm" data-testid="representative-account-hint" aria-live="polite">
      {t`Conta: ${name}`}
    </p>
  );
};
