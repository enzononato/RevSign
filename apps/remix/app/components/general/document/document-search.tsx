import { useDebouncedValue } from '@documenso/lib/client-only/hooks/use-debounced-value';
import { cn } from '@documenso/ui/lib/utils';
import { Input } from '@documenso/ui/primitives/input';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { SearchIcon } from 'lucide-react';
import { useQueryStates } from 'nuqs';
import { useEffect, useState } from 'react';

import { documentsSearchParams } from '~/utils/documents-search-params';

export const DocumentSearch = ({ className }: { className?: string }) => {
  const { _ } = useLingui();

  const [{ query }, setSearchParams] = useQueryStates(
    {
      query: documentsSearchParams.query,
      page: documentsSearchParams.page,
    },
    { history: 'push' },
  );

  const [searchTerm, setSearchTerm] = useState(query ?? '');
  const debouncedSearchTerm = useDebouncedValue(searchTerm, 500);

  useEffect(() => {
    if (debouncedSearchTerm !== (query ?? '')) {
      // Reset pagination so a new search never lands on an empty page.
      void setSearchParams({
        query: debouncedSearchTerm || null,
        page: null,
      });
    }
  }, [debouncedSearchTerm, query, setSearchParams]);

  // REVALLE v3: busca com a lupa dentro da caixa (linha inteira na barra de filtros)
  return (
    <div className={cn('relative', className)}>
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        strokeWidth={2.2}
        aria-hidden
      />

      <Input
        type="search"
        className="pl-10"
        placeholder={_(msg`Search documents...`)}
        aria-label={_(msg`Search documents...`)}
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
      />
    </div>
  );
};
