import { env } from '@documenso/lib/utils/env';
import { cn } from '@documenso/ui/lib/utils';
import { useMatches } from 'react-router';

const DEFAULT_SOURCE_URL = 'https://github.com/enzononato/RevSign';

/**
 * Link "Código-fonte" exigido pela AGPL-3.0 (§13) em todas as telas.
 *
 * Fica fora das rotas internas (ex.: o HTML que vira o certificado em PDF).
 * Nas telas de destinatário, o padding extra evita que o widget fixo de
 * assinatura no celular cubra o link.
 */
export const SourceCodeLink = () => {
  const matches = useMatches();

  const isInternalRoute = matches.some((match) => match.id?.startsWith('routes/_internal+'));
  const isRecipientRoute = matches.some((match) => match.id?.startsWith('routes/_recipient+'));

  if (isInternalRoute) {
    return null;
  }

  const sourceUrl = env('NEXT_PUBLIC_REVALLE_SOURCE_URL') || DEFAULT_SOURCE_URL;

  return (
    <footer className={cn('py-4 text-center text-muted-foreground text-xs', isRecipientRoute && 'pb-32 lg:pb-4')}>
      <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline">
        Código-fonte (AGPL-3.0)
      </a>
    </footer>
  );
};
