import { env } from '@documenso/lib/utils/env';
import { cn } from '@documenso/ui/lib/utils';
import { useMatches } from 'react-router';

import { isInsideAppShell } from './shell/shell-routes';

const DEFAULT_SOURCE_URL = 'https://github.com/enzononato/RevSign';

export type SourceCodeLinkProps = {
  /** `footer` is the page footer from root; `shell` is the last line of the blue sidebar and mobile sheet. */
  variant?: 'footer' | 'shell';
  className?: string;
};

/**
 * Link "Código-fonte" exigido pela AGPL-3.0 (§13) em todas as telas.
 *
 * Fica fora das rotas internas (ex.: o HTML que vira o certificado em PDF).
 * Nas telas de destinatário, o padding extra evita que o widget fixo de
 * assinatura no celular cubra o link. Dentro do shell azul, no computador o
 * link mora na barra lateral, então o rodapé só aparece no celular. Nas telas
 * de acesso, no computador, ele mora no painel azul da esquerda.
 */
export const SourceCodeLink = ({ variant = 'footer', className }: SourceCodeLinkProps) => {
  const matches = useMatches();

  const isInternalRoute = matches.some((match) => match.id?.startsWith('routes/_internal+'));
  const isRecipientRoute = matches.some((match) => match.id?.startsWith('routes/_recipient+'));
  // REVALLE: redesign v3. Nas telas de acesso, no computador, o link mora no painel azul da esquerda.
  const isAuthRoute = matches.some((match) => match.id?.startsWith('routes/_unauthenticated+'));

  if (isInternalRoute) {
    return null;
  }

  const sourceUrl = env('NEXT_PUBLIC_REVALLE_SOURCE_URL') || DEFAULT_SOURCE_URL;

  if (variant === 'shell') {
    return (
      <a
        href={sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          'self-start rounded-md px-2.5 text-[11.5px] text-shell-muted underline-offset-4 hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white',
          className,
        )}
      >
        Código-fonte (AGPL-3.0)
      </a>
    );
  }

  return (
    <footer
      className={cn(
        'py-4 text-center text-muted-foreground text-xs',
        isRecipientRoute && 'pb-32 lg:pb-4',
        isInsideAppShell(matches) && 'md:hidden',
        isAuthRoute && 'lg:hidden',
      )}
    >
      <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline">
        Código-fonte (AGPL-3.0)
      </a>
    </footer>
  );
};
