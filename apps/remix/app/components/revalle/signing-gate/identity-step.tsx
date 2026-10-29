import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { Plural, Trans } from '@lingui/react/macro';
import { Loader } from 'lucide-react';
import { useState } from 'react';

import { GateError } from './gate-error';
import { maskBirthDate, maskCpf } from './masks';

export type IdentityStepProps = {
  token: string;
  attemptsLeft: number;
  onDone: () => void;
};

export const IdentityStep = ({ token, attemptsLeft, onDone }: IdentityStepProps) => {
  const [cpf, setCpf] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [failed, setFailed] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [currentAttempts, setCurrentAttempts] = useState(attemptsLeft);

  const { mutateAsync, isPending } = trpc.revalle.gate.verifyIdentity.useMutation();

  const isComplete = cpf.replace(/\D/g, '').length === 11 && birthDate.replace(/\D/g, '').length === 8;

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!isComplete) {
      return;
    }

    setFailed(false);
    setUnreachable(false);

    try {
      const state = await mutateAsync({ token, cpf, birthDate });

      if (state.status === 'IDENTITY_REQUIRED') {
        setFailed(true);
        setCurrentAttempts(state.attemptsLeft);
        setBirthDate('');

        return;
      }

      onDone();
    } catch {
      setUnreachable(true);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <h1 className="font-bold text-2xl">
        <Trans>Confirme que é você</Trans>
      </h1>

      <p>
        <Trans>Na primeira assinatura, precisamos confirmar seus dados com o cadastro de colaboradores.</Trans>
      </p>

      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="revalle-cpf" className="text-base">
            <Trans>CPF</Trans>
          </Label>
          <Input
            id="revalle-cpf"
            name="cpf"
            className="h-12 text-base"
            inputMode="numeric"
            autoComplete="off"
            placeholder="000.000.000-00"
            value={cpf}
            onChange={(event) => setCpf(maskCpf(event.target.value))}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="revalle-birth-date" className="text-base">
            <Trans>Data de nascimento</Trans>
          </Label>
          <Input
            id="revalle-birth-date"
            name="birthDate"
            className="h-12 text-base"
            inputMode="numeric"
            autoComplete="off"
            placeholder="dd/mm/aaaa"
            value={birthDate}
            onChange={(event) => setBirthDate(maskBirthDate(event.target.value))}
          />
        </div>

        {failed && (
          <GateError>
            <Plural
              value={currentAttempts}
              one="CPF ou data de nascimento não conferem. Você tem # tentativa."
              other="CPF ou data de nascimento não conferem. Você tem # tentativas."
            />
          </GateError>
        )}

        {unreachable && (
          <GateError>
            <Trans>Não foi possível confirmar agora. Tente novamente em alguns minutos.</Trans>
          </GateError>
        )}

        <Button type="submit" size="lg" className="h-12 w-full text-base" disabled={!isComplete || isPending}>
          {isPending && <Loader className="mr-2 h-5 w-5 animate-spin" />}
          <Trans>Confirmar</Trans>
        </Button>
      </form>
    </section>
  );
};
