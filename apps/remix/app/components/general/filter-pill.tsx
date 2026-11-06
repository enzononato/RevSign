import { cn } from '@documenso/ui/lib/utils';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@documenso/ui/primitives/command';
import { Popover, PopoverContent, PopoverTrigger } from '@documenso/ui/primitives/popover';
import { Trans } from '@lingui/react/macro';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react/dist/lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';

export type FilterPillOption = {
  value: string;
  label: ReactNode;
  trailing?: string;
};

type FilterPillCommonProps = {
  icon: LucideIcon;
  label: ReactNode;
  options: FilterPillOption[];
  enableSearch?: boolean;
  searchPlaceholder?: string;
  loading?: boolean;
  /** Whether the selection can be removed. Defaults to true. */
  clearable?: boolean;
  testId?: string;
};

export type FilterPillSingleProps = FilterPillCommonProps & {
  multiple?: false;
  value: string | null;
  onChange: (value: string | null) => void;
  selectedLabel?: ReactNode;
};

export type FilterPillMultipleProps = FilterPillCommonProps & {
  multiple: true;
  value: string[];
  onChange: (value: string[]) => void;
};

export type FilterPillProps = FilterPillSingleProps | FilterPillMultipleProps;

/**
 * A faceted filter pill.
 *
 * Renders as a labeled filter box ("Status  Todos"), and shows the current
 * selection inline once a value is picked. Selecting the active option
 * again (or the Clear row) removes it.
 *
 * Single select by default, closing on pick. When `multiple` is set the
 * popover stays open for toggling, and the trigger shows the first
 * selection followed by "+N more".
 */
export const FilterPill = (props: FilterPillProps) => {
  // REVALLE v3: o ícone não aparece mais na caixa (o rótulo já diz o filtro); a prop continua para não quebrar quem usa.
  const { label, options, enableSearch, searchPlaceholder, loading, clearable = true, testId } = props;

  const [open, setOpen] = useState(false);

  const selectedValues = props.multiple ? props.value : props.value === null ? [] : [props.value];

  const selectedOptions = selectedValues
    .map((value) => options.find((option) => option.value === value))
    .filter((option): option is FilterPillOption => option !== undefined);

  const hasSelection = selectedOptions.length > 0;
  // REVALLE v3: a caixa mostra a primeira escolha e "+N" das demais.
  const extraCount = selectedOptions.length - 1;

  const onSelect = (nextValue: string) => {
    if (props.multiple) {
      const newValues = selectedValues.includes(nextValue)
        ? selectedValues.filter((value) => value !== nextValue)
        : [...selectedValues, nextValue];

      props.onChange(newValues);
      return;
    }

    props.onChange(nextValue === props.value && clearable ? null : nextValue);
    setOpen(false);
  };

  const onClear = () => {
    if (props.multiple) {
      props.onChange([]);
    } else {
      props.onChange(null);
    }

    setOpen(false);
  };

  // REVALLE v3: caixa de filtro rotulada (raio 13, regra 1,5px, valor em negrito); com valor, o estilo azul "set".
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={loading}
          className={cn(
            'inline-flex h-11 max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-card pr-3 pl-3.5 font-semibold text-muted-foreground text-sm shadow-[inset_0_0_0_1.5px_hsl(var(--border))] transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
            {
              'bg-accent/60 shadow-[inset_0_0_0_2px_hsl(var(--primary))] dark:shadow-[inset_0_0_0_2px_hsl(var(--brand-text))]':
                hasSelection,
            },
          )}
          data-testid={testId}
        >
          <span>{label}</span>

          <span
            className={cn('flex min-w-0 items-center gap-x-1 truncate font-bold text-foreground', {
              'text-brand-text': hasSelection,
            })}
          >
            {!hasSelection ? (
              <Trans>All</Trans>
            ) : props.multiple ? (
              <>
                <span className="truncate">{selectedOptions[0].label}</span>

                {selectedOptions.length > 1 && (
                  <span className="shrink-0">
                    <Trans>+{extraCount} more</Trans>
                  </span>
                )}
              </>
            ) : (
              <span className="truncate">{props.selectedLabel ?? selectedOptions[0].label}</span>
            )}
          </span>

          <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={2.5} />
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-60 p-0" align="start">
        <Command>
          {enableSearch && <CommandInput placeholder={searchPlaceholder} />}

          <CommandList>
            <CommandEmpty>
              <Trans>No results found.</Trans>
            </CommandEmpty>

            <CommandGroup>
              {options.map((option) => (
                <CommandItem key={option.value} onSelect={() => onSelect(option.value)}>
                  <CheckIcon
                    className={cn(
                      'mr-2 h-4 w-4 shrink-0',
                      selectedValues.includes(option.value) ? 'opacity-100' : 'opacity-0',
                    )}
                  />

                  {option.label}

                  {option.trailing !== undefined && (
                    <span className="ml-auto pl-4 text-muted-foreground text-xs">{option.trailing}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>

            {hasSelection && clearable && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem className="justify-center text-center text-muted-foreground" onSelect={onClear}>
                    <Trans>Clear</Trans>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
