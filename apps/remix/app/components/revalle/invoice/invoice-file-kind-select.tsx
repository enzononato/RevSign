import { cn } from '@documenso/ui/lib/utils';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';

export type InvoiceFileKindChoice = 'NF' | 'BOLETO' | 'OTHER';

export type InvoiceFileKindSelectProps = {
  /** O tipo atual (nenhum marcado num arquivo sem texto, que ainda não tem tipo). */
  value: InvoiceFileKindChoice | null;
  onSelect: (kind: InvoiceFileKindChoice) => void;
  disabled?: boolean;
  /** Rótulo do grupo ("Este arquivo é:"); sem ele, o grupo leva só o nome acessível. */
  label?: ReactNode;
  testId?: string;
};

const OPTIONS: Array<{ kind: InvoiceFileKindChoice; label: ReactNode }> = [
  { kind: 'NF', label: <Trans>Nota fiscal</Trans> },
  { kind: 'BOLETO', label: <Trans>Boleto</Trans> },
  { kind: 'OTHER', label: <Trans>Outro documento</Trans> },
];

/**
 * Fase 9: "Este arquivo é: Nota fiscal / Boleto / Outro documento", três botões lado a lado (44 px de toque; o texto
 * quebra em duas linhas no celular em vez de passar da largura). Grava na hora (`setFileKind`).
 */
export const InvoiceFileKindSelect = ({
  value,
  onSelect,
  disabled = false,
  label,
  testId,
}: InvoiceFileKindSelectProps) => {
  const { t } = useLingui();
  const hasLabel = label !== undefined && label !== null;

  return (
    <fieldset
      className="flex min-w-0 flex-col gap-1.5"
      aria-label={hasLabel ? undefined : t`Tipo do arquivo`}
      data-testid={testId}
    >
      {hasLabel && <legend className="mb-1.5 font-medium text-sm">{label}</legend>}

      <div className="grid grid-cols-3 gap-2">
        {OPTIONS.map((option) => (
          <button
            key={option.kind}
            type="button"
            aria-pressed={value === option.kind}
            disabled={disabled}
            className={cn(
              'flex min-h-11 min-w-0 items-center justify-center rounded-md border px-2 py-1.5 text-center font-medium text-sm leading-tight hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
              value === option.kind && 'border-primary bg-accent',
            )}
            onClick={() => {
              if (value !== option.kind) {
                onSelect(option.kind);
              }
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
};
