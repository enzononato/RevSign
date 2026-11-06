import { cn } from '@documenso/ui/lib/utils';
import { ChevronDownIcon } from 'lucide-react';
import { forwardRef, type ReactNode } from 'react';

/** Caixa de filtro do redesign v3: rótulo + valor atual; azul quando o filtro restringe a lista. */
export const filterBoxClassName = (isSet: boolean) =>
  cn(
    'relative inline-flex h-11 min-w-0 w-full md:w-auto md:shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[13px] bg-card pl-3 pr-2.5 font-semibold text-[13px] text-muted-foreground md:pl-3.5 md:pr-3 md:text-sm transition-colors',
    'ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2',
    isSet
      ? 'bg-accent shadow-[inset_0_0_0_2px_hsl(var(--brand-text))]'
      : 'shadow-[inset_0_0_0_1.5px_hsl(var(--border))] hover:shadow-[inset_0_0_0_1.5px_hsl(var(--muted-foreground)/0.5)]',
  );

const FilterBoxValue = ({ label, value, isSet }: { label: ReactNode; value: ReactNode; isSet: boolean }) => (
  <>
    <span>{label}</span>
    <span
      className={cn('min-w-0 flex-1 truncate font-bold md:flex-none', isSet ? 'text-brand-text' : 'text-foreground')}
    >
      {value}
    </span>
    <ChevronDownIcon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} aria-hidden />
  </>
);

export type FilterSelectBoxProps = {
  id: string;
  label: ReactNode;
  /** Nome completo do filtro para leitor de tela (o rótulo visível é curto). */
  ariaLabel: string;
  value: string;
  /** `short`: o texto na caixa, quando o rótulo da opção repete o nome do filtro. */
  options: { value: string; label: string; short?: string }[];
  isSet: boolean;
  onChange: (value: string) => void;
};

/**
 * O `<select>` nativo de antes, invisível por cima da caixa: abre o seletor do sistema (no celular, a roda de opções) e
 * continua acessível pelo teclado.
 */
export const FilterSelectBox = ({ id, label, ariaLabel, value, options, isSet, onChange }: FilterSelectBoxProps) => {
  const selected = options.find((option) => option.value === value) ?? options[0];
  const current = selected?.short ?? selected?.label ?? '';

  return (
    <label htmlFor={id} className={cn(filterBoxClassName(isSet), 'cursor-pointer')}>
      <FilterBoxValue label={label} value={current} isSet={isSet} />
      <select
        id={id}
        aria-label={ariaLabel}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
};

export type FilterButtonBoxProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: ReactNode;
  value: ReactNode;
  isSet: boolean;
};

/** A mesma caixa como botão (abre um popover), para os filtros que não cabem num `<select>`. */
export const FilterButtonBox = forwardRef<HTMLButtonElement, FilterButtonBoxProps>(
  ({ label, value, isSet, className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(filterBoxClassName(isSet), 'focus-visible:outline-none', className)}
      {...props}
    >
      <FilterBoxValue label={label} value={value} isSet={isSet} />
    </button>
  ),
);

FilterButtonBox.displayName = 'FilterButtonBox';
