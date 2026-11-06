import { cn } from '@documenso/ui/lib/utils';

export type RevsignWordmarkProps = {
  /** `onBrand` sobre o azul da barra lateral e das faixas; `onLight` sobre fundo claro ou escuro neutro. */
  variant?: 'onBrand' | 'onLight';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Mostra "assinaturas da revalle" embaixo (ou ao lado, no tamanho sm). */
  withTagline?: boolean;
  className?: string;
};

const SIZES = {
  sm: 'text-[22px]',
  md: 'text-[28px]',
  lg: 'text-[34px]',
  xl: 'text-[56px]',
};

export const RevsignWordmark = ({
  variant = 'onLight',
  size = 'lg',
  withTagline = false,
  className,
}: RevsignWordmarkProps) => {
  const isOnBrand = variant === 'onBrand';

  return (
    <span
      className={cn('inline-flex select-none', size === 'sm' ? 'items-baseline gap-2' : 'flex-col', className)}
      role="img"
      aria-label="RevSign"
    >
      <span
        aria-hidden
        className={cn(
          'font-black font-display leading-none tracking-[-0.035em]',
          SIZES[size],
          isOnBrand ? 'text-white' : 'text-foreground',
        )}
      >
        Rev
        <span className={isOnBrand ? 'text-[#9EC0FF]' : 'text-brand-text'}>Sign</span>
      </span>

      {withTagline && (
        <span
          aria-hidden
          className={cn(
            'font-medium text-[12px] leading-snug',
            size === 'sm' ? '' : 'mt-2',
            isOnBrand ? 'text-shell-muted' : 'text-muted-foreground',
          )}
        >
          assinaturas da{' '}
          <span
            className={cn(
              'font-black font-display text-[14px] tracking-[-0.03em]',
              isOnBrand ? 'text-white' : 'text-foreground',
            )}
          >
            revalle
          </span>
        </span>
      )}
    </span>
  );
};
