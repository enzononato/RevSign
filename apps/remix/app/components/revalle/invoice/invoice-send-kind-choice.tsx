import { cn } from '@documenso/ui/lib/utils';
import { RadioGroup, RadioGroupItem } from '@documenso/ui/primitives/radio-group';
import { Trans, useLingui } from '@lingui/react/macro';

/** "Apenas assinar" = o envio não é nota fiscal; "Nota fiscal" = pede a conta e o centro e passa pelo Financeiro. */
export type InvoiceSendKind = 'SIGN_ONLY' | 'INVOICE';

export type InvoiceSendKindChoiceProps = {
  /** `null` enquanto a pessoa não respondeu (arquivo sem texto): nenhuma opção marcada. */
  value: InvoiceSendKind | null;
  disabled?: boolean;
  className?: string;
  onChange: (value: InvoiceSendKind) => void;
};

/**
 * Escolha do topo do diálogo de envio: só assinar ou nota fiscal. Cartões de rádio (o cartão inteiro escolhe), no mesmo
 * desenho da escolha "Como enviar" do diálogo. Setas do teclado trocam a opção (Radix).
 */
export const InvoiceSendKindChoice = ({ value, disabled, className, onChange }: InvoiceSendKindChoiceProps) => {
  const { t } = useLingui();

  const options = [
    {
      value: 'SIGN_ONLY' as const,
      title: <Trans>Apenas assinar</Trans>,
      description: <Trans>Sem conta contábil, centro de custo ou OBZ. Vai direto para quem assina.</Trans>,
    },
    {
      value: 'INVOICE' as const,
      title: <Trans>Nota fiscal</Trans>,
      description: <Trans>Pede conta contábil e centro de custo e passa pela aprovação do Financeiro.</Trans>,
    },
  ];

  return (
    <RadioGroup
      // Sem resposta, o Radix precisa de uma string vazia (não `undefined`) para continuar controlado.
      value={value ?? ''}
      onValueChange={(next) => {
        if (next === 'SIGN_ONLY' || next === 'INVOICE') {
          onChange(next);
        }
      }}
      aria-label={t`O que este envio é`}
      className={cn('mb-4 gap-3', className)}
      disabled={disabled}
      data-testid="invoice-send-kind"
    >
      {options.map((option) => (
        // O cartão inteiro é o rótulo: clicar em qualquer ponto escolhe a opção, e o toque tem a altura do cartão.
        <label
          key={option.value}
          htmlFor={`invoice-send-kind-${option.value}`}
          className={cn(
            'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors',
            value === option.value && 'border-primary bg-primary/5',
            disabled && 'cursor-not-allowed opacity-70',
          )}
        >
          <RadioGroupItem
            id={`invoice-send-kind-${option.value}`}
            value={option.value}
            aria-labelledby={`invoice-send-kind-${option.value}-title`}
            aria-describedby={`invoice-send-kind-${option.value}-description`}
            className="mt-0.5"
            data-testid={`invoice-send-kind-${option.value}`}
          />

          <span className="flex min-w-0 flex-col gap-1">
            <span id={`invoice-send-kind-${option.value}-title`} className="font-medium text-foreground text-sm">
              {option.title}
            </span>

            <span id={`invoice-send-kind-${option.value}-description`} className="text-muted-foreground text-xs">
              {option.description}
            </span>
          </span>
        </label>
      ))}
    </RadioGroup>
  );
};
