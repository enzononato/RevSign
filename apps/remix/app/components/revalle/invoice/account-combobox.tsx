import { searchAccounts } from '@documenso/lib/revalle/invoice/account-search';
import { cn } from '@documenso/ui/lib/utils';
import { Input } from '@documenso/ui/primitives/input';
import { Trans, useLingui } from '@lingui/react/macro';
import { CheckIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

export type InvoiceAccountOption = { code: string; name: string };

export type AccountComboboxProps = {
  accounts: InvoiceAccountOption[];
  value: string | null;
  onSelect: (code: string) => void;
  disabled?: boolean;
};

// A lista pode ter milhares de contas: só as primeiras aparecem; a busca encontra as outras.
const MAX_RESULTS = 50;

/** Busca por número ou nome (sem acento), com a lista logo abaixo; toque de 44 px em cada conta. */
export const AccountCombobox = ({ accounts, value, onSelect, disabled = false }: AccountComboboxProps) => {
  const { t } = useLingui();
  const listId = useId();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => searchAccounts(accounts, query), [accounts, query]);

  const visible = filtered.slice(0, MAX_RESULTS);
  const shown = visible.length;
  const total = filtered.length;

  return (
    <div className="flex flex-col gap-2">
      <Input
        type="search"
        aria-controls={listId}
        aria-label={t`Buscar conta por número ou nome`}
        placeholder={t`Buscar conta por número ou nome`}
        className="h-11"
        value={query}
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // Dentro do formulário de envio, Enter enviaria o documento. Com uma conta só na lista, escolhe ela.
          if (event.key === 'Enter') {
            event.preventDefault();

            if (visible.length === 1) {
              onSelect(visible[0].code);
            }
          }
        }}
      />

      <ul id={listId} className="max-h-48 overflow-y-auto rounded-md border">
        {visible.map((account) => (
          <li key={account.code}>
            <button
              type="button"
              aria-pressed={account.code === value}
              disabled={disabled}
              className={cn(
                'flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-50',
                account.code === value && 'bg-accent',
              )}
              onClick={() => onSelect(account.code)}
            >
              <CheckIcon className={cn('h-4 w-4 shrink-0', account.code === value ? 'opacity-100' : 'opacity-0')} />
              <span className="shrink-0 font-mono">{account.code}</span>
              <span className="min-w-0 flex-1 break-words">{account.name}</span>
            </button>
          </li>
        ))}

        {total === 0 && (
          <li className="px-3 py-2 text-muted-foreground text-sm">
            <Trans>Nenhuma conta encontrada.</Trans>
          </li>
        )}
      </ul>

      {total > shown && (
        <p className="text-muted-foreground text-xs">
          <Trans>
            Mostrando {shown} de {total} contas. Digite para encontrar as outras.
          </Trans>
        </p>
      )}
    </div>
  );
};
