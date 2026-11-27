import { useOptionalSession } from '@documenso/lib/client-only/providers/session'; // REVALLE: v.26 autenticador
import type { TRecipientAccessAuth } from '@documenso/lib/types/document-auth';
import { trpc } from '@documenso/trpc/react';
import { cn } from '@documenso/ui/lib/utils';
import { Alert } from '@documenso/ui/primitives/alert';
import { Button } from '@documenso/ui/primitives/button';
import { Form, FormField, FormItem } from '@documenso/ui/primitives/form/form';
import { PinInput, PinInputGroup, PinInputSlot } from '@documenso/ui/primitives/pin-input';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { zodResolver } from '@hookform/resolvers/zod';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { KeyIcon, MailIcon } from 'lucide-react'; // REVALLE: autenticador (v.26) ou e-mail
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

// REVALLE: por e-mail; ou (v.26) pelo app autenticador quando a sessão é a conta dona do e-mail e tem o autenticador ligado.
type FormStep = 'authenticator' | 'request-code' | 'code-input';

const ZAccessAuth2FAFormSchema = z.object({
  token: z.string().length(6, { message: 'Token must be 6 characters long' }),
});

type TAccessAuth2FAFormSchema = z.infer<typeof ZAccessAuth2FAFormSchema>;

export type AccessAuth2FAFormProps = {
  onSubmit: (accessAuthOptions: TRecipientAccessAuth) => void;
  token: string;
  error?: string | null;
  /** REVALLE: e-mail do destinatário; o autenticador só aparece para a conta logada desse e-mail. */
  recipientEmail?: string;
};

export const AccessAuth2FAForm = ({ onSubmit, token, error, recipientEmail }: AccessAuth2FAFormProps) => {
  // REVALLE: o servidor confere de novo (conta dona do e-mail, autenticador ligado); aqui só escolhe o passo inicial.
  const { sessionData } = useOptionalSession();
  const canUseAuthenticator = Boolean(
    sessionData?.user.twoFactorEnabled &&
      recipientEmail &&
      sessionData.user.email.trim().toLowerCase() === recipientEmail.trim().toLowerCase(),
  );

  const [step, setStep] = useState<FormStep>(canUseAuthenticator ? 'authenticator' : 'request-code');

  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [millisecondsRemaining, setMillisecondsRemaining] = useState<number | null>(null);

  const { _ } = useLingui();
  const { toast } = useToast();

  const { mutateAsync: request2FAEmail, isPending: isRequesting2FAEmail } =
    trpc.document.accessAuth.request2FAEmail.useMutation();

  const form = useForm({
    resolver: zodResolver(ZAccessAuth2FAFormSchema),
    defaultValues: {
      token: '',
    },
  });

  const requestCode = async () => {
    try {
      const result = await request2FAEmail({
        token: token,
      });

      setExpiresAt(result.expiresAt);
      setMillisecondsRemaining(result.expiresAt.valueOf() - Date.now());

      setStep('code-input');
    } catch (error) {
      toast({
        title: _(msg`Não foi possível enviar o código`),
        description: _(msg`Aguarde um pouco e tente de novo.`),
        variant: 'destructive',
      });
    }
  };

  const onFormSubmit = (data: TAccessAuth2FAFormSchema) => {
    const accessAuthOptions: TRecipientAccessAuth = {
      type: 'TWO_FACTOR_AUTH',
      token: data.token,
      method: step === 'authenticator' ? 'authenticator' : 'email', // REVALLE: v.26
    };

    onSubmit(accessAuthOptions);
  };

  useEffect(() => {
    const interval = setInterval(() => {
      if (expiresAt) {
        setMillisecondsRemaining(expiresAt.valueOf() - Date.now());
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [expiresAt]);

  // REVALLE: v.26, "Prefiro receber o código por e-mail" volta ao fluxo do e-mail (o código digitado é descartado).
  const switchToEmail = () => {
    form.reset({ token: '' });
    setStep('request-code');
  };

  const codeInput = (
    <FormField
      control={form.control}
      name="token"
      render={({ field }) => (
        <FormItem className="flex-1 items-center justify-center">
          <PinInput
            {...field}
            maxLength={6}
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="^\d+$"
            aria-label="Código de 6 dígitos"
            containerClassName="h-12 justify-center"
          >
            <PinInputGroup>
              <PinInputSlot className="h-12 w-12 text-lg" index={0} />
              <PinInputSlot className="h-12 w-12 text-lg" index={1} />
              <PinInputSlot className="h-12 w-12 text-lg" index={2} />
              <PinInputSlot className="h-12 w-12 text-lg" index={3} />
              <PinInputSlot className="h-12 w-12 text-lg" index={4} />
              <PinInputSlot className="h-12 w-12 text-lg" index={5} />
            </PinInputGroup>
          </PinInput>

          {step === 'code-input' && expiresAt && millisecondsRemaining !== null && (
            <div
              className={cn('mt-2 text-center text-muted-foreground text-sm', {
                'text-destructive': millisecondsRemaining <= 0,
              })}
            >
              <Trans>
                O código vale por {DateTime.fromMillis(Math.max(millisecondsRemaining, 0)).toFormat('mm:ss')}
              </Trans>
            </div>
          )}
        </FormItem>
      )}
    />
  );

  return (
    <div className="py-4">
      {step === 'authenticator' && (
        <div className="space-y-4">
          <h3 className="font-semibold text-lg">
            <Trans>Digite o código do seu app autenticador</Trans>
          </h3>

          {error && (
            <Alert variant="destructive" padding="tight" className="text-sm">
              {error}
            </Alert>
          )}

          <Form {...form}>
            <form id="access-auth-2fa-form" className="space-y-4" onSubmit={form.handleSubmit(onFormSubmit)}>
              <fieldset disabled={form.formState.isSubmitting}>
                {codeInput}

                <div className="mt-4 space-y-2">
                  <Button
                    type="submit"
                    form="access-auth-2fa-form"
                    className="h-11 w-full"
                    disabled={!form.formState.isValid}
                    loading={form.formState.isSubmitting}
                  >
                    <KeyIcon className="mr-2 h-5 w-5" />
                    <Trans>Confirmar e concluir</Trans>
                  </Button>

                  <Button type="button" variant="ghost" size="sm" className="h-11 w-full" onClick={switchToEmail}>
                    <Trans>Prefiro receber o código por e-mail</Trans>
                  </Button>
                </div>
              </fieldset>
            </form>
          </Form>
        </div>
      )}

      {step === 'request-code' && (
        <div className="space-y-4">
          <div>
            <h3 className="font-semibold text-lg">
              <Trans>Confirme que você é o destinatário</Trans>
            </h3>
            <p className="text-muted-foreground text-sm">
              <Trans>
                Vamos enviar um código de 6 dígitos para seu e-mail. Ele é necessário para concluir o documento.
              </Trans>
            </p>
          </div>

          {error && (
            <Alert variant="destructive" padding="tight" className="text-sm">
              {error}
            </Alert>
          )}

          <Button type="button" size="lg" className="w-full" onClick={requestCode} loading={isRequesting2FAEmail}>
            <MailIcon className="mr-2 h-5 w-5" />
            <Trans>Enviar código para meu e-mail</Trans>
          </Button>
        </div>
      )}

      {step === 'code-input' && (
        <div className="space-y-4">
          <h3 className="font-semibold text-lg">
            <Trans>Digite o código</Trans>
          </h3>

          {/* REVALLE: frase curta (linguagem simples, Fase 2 Task 4) */}
          <div className="text-muted-foreground text-sm">
            <Trans>Enviamos um código de 6 dígitos para o seu e-mail. Digite o código abaixo para concluir.</Trans>
          </div>

          {error && (
            <Alert variant="destructive" padding="tight" className="text-sm">
              {error}
            </Alert>
          )}

          <Form {...form}>
            <form id="access-auth-2fa-form" className="space-y-4" onSubmit={form.handleSubmit(onFormSubmit)}>
              <fieldset disabled={isRequesting2FAEmail || form.formState.isSubmitting}>
                {codeInput}

                <div className="mt-4 space-y-2">
                  <Button
                    type="submit"
                    form="access-auth-2fa-form"
                    className="h-11 w-full" // REVALLE: h-11 (44 px de área de toque)
                    disabled={!form.formState.isValid}
                    loading={isRequesting2FAEmail || form.formState.isSubmitting}
                  >
                    <Trans>Confirmar e concluir</Trans>
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-11 w-full" // REVALLE: h-11 (44 px de área de toque)
                    onClick={requestCode}
                    loading={isRequesting2FAEmail}
                  >
                    <Trans>Reenviar código</Trans>
                  </Button>
                </div>
              </fieldset>
            </form>
          </Form>
        </div>
      )}
    </div>
  );
};
