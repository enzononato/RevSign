import { cn } from '@documenso/ui/lib/utils';
import { Card } from '@documenso/ui/primitives/card';
import type { ReactNode } from 'react';

import { RevsignWordmark } from '~/components/revalle/shell/revsign-wordmark';

/** Grade fina do engradado sobre o azul (mesma da barra lateral). */
export const SIGNING_BAND_GRID =
  'bg-[image:repeating-linear-gradient(90deg,rgba(255,255,255,.045)_0_1px,transparent_1px_24px),repeating-linear-gradient(0deg,rgba(255,255,255,.045)_0_1px,transparent_1px_24px)]';

export type SigningBandProps = {
  /** Título grande da faixa (documento ou saudação). */
  title?: ReactNode;
  /** `p` quando o título da página é outro (ex.: o passo do portão, que é o h1 do cartão). */
  titleAs?: 'h1' | 'p';
  /** Linha abaixo do título (quem enviou). */
  subtitle?: ReactNode;
  /** Texto curto no canto, ao lado da marca (ex.: "Assinatura 3 de 3"). */
  step?: ReactNode;
  /** Botões no canto (ex.: menu de ações no celular). */
  actions?: ReactNode;
  /** Substitui a marca RevSign (logo do time, quando a marca própria está ligada). */
  logo?: ReactNode;
  /**
   * `stacked`: faixa do celular em todos os tamanhos (portão e páginas de um cartão).
   * `signing`: no desktop vira uma faixa reta de uma linha (marca | título | canto), acima do PDF.
   */
  layout?: 'stacked' | 'signing';
  /** Largura do conteúdo da faixa `stacked` (alinha com o cartão abaixo). */
  contentClassName?: string;
  className?: string;
  as?: 'header' | 'nav';
};

/**
 * Faixa azul do topo das telas públicas de quem assina: marca, texto da etapa, título e remetente. No celular tem os cantos
 * de baixo arredondados (26px), como no preview aprovado.
 */
export const SigningBand = ({
  title,
  titleAs = 'h1',
  subtitle,
  step,
  actions,
  logo,
  layout = 'stacked',
  contentClassName,
  className,
  as: Root = 'header',
}: SigningBandProps) => {
  const isSigning = layout === 'signing';
  const Title = titleAs;

  return (
    <Root
      // A grade fica fora do cn: o tailwind-merge trata bg-[image:…] como cor de fundo e apagaria o bg-shell.
      className={`${cn(
        'relative rounded-b-[26px] bg-shell px-5 pt-[18px] pb-[22px] text-shell-foreground',
        isSigning && 'lg:rounded-none lg:px-6 lg:py-4',
        className,
      )} ${SIGNING_BAND_GRID}`}
    >
      <div
        className={cn(
          'mx-auto grid w-full grid-cols-[1fr_auto] items-center gap-x-3',
          isSigning && 'lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:gap-x-6',
          !isSigning && 'max-w-xl sm:px-4',
          contentClassName,
        )}
      >
        <div className="col-start-1 row-start-1 flex min-w-0 items-center">
          {logo ?? (
            <>
              <RevsignWordmark variant="onBrand" size="sm" className={cn(isSigning && 'lg:hidden')} />
              {isSigning && (
                <RevsignWordmark variant="onBrand" size="sm" withTagline className="hidden lg:inline-flex" />
              )}
            </>
          )}
        </div>

        {(step || actions) && (
          <div
            className={cn('col-start-2 row-start-1 flex items-center justify-end gap-3', isSigning && 'lg:col-start-3')}
          >
            {step && <span className="font-semibold text-[12.5px] text-shell-muted tabular-nums">{step}</span>}
            {actions}
          </div>
        )}

        {(title || subtitle) && (
          <div
            className={cn(
              'col-span-2 row-start-2 mt-[18px] min-w-0',
              isSigning && 'lg:col-span-1 lg:col-start-2 lg:row-start-1 lg:mt-0 lg:border-white/15 lg:border-l lg:pl-6',
            )}
          >
            {title && (
              <Title
                className={cn(
                  'break-words font-black font-display text-[23px] leading-[1.15] tracking-[-0.02em] [text-wrap:balance]',
                  isSigning && 'lg:truncate lg:text-[19px] lg:leading-tight',
                )}
              >
                {title}
              </Title>
            )}

            {subtitle && (
              <p className={cn('mt-1 text-[13.5px] text-shell-muted', isSigning && 'lg:mt-0.5 lg:truncate')}>
                {subtitle}
              </p>
            )}
          </div>
        )}
      </div>
    </Root>
  );
};

export type SigningPageFrameProps = Omit<SigningBandProps, 'layout'> & {
  children: ReactNode;
  /** Abaixo do cartão (ex.: um segundo bloco, como o "Criar conta"). */
  after?: ReactNode;
  cardClassName?: string;
};

/** Faixa azul + um cartão: portão, concluído, recusado, expirado, esperando a vez. */
export const SigningPageFrame = ({ children, after, cardClassName, ...band }: SigningPageFrameProps) => (
  <div className="min-h-[calc(100dvh-4rem)] bg-background">
    <SigningBand {...band} layout="stacked" />

    <div className="mx-auto w-full max-w-xl px-4 pt-4 pb-8 sm:pt-6">
      <Card backdropBlur={false} className={cn('p-5 sm:p-7', cardClassName)}>
        {children}
      </Card>

      {after}
    </div>
  </div>
);
