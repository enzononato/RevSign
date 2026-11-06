// REVALLE: redesign v3. O padrão de fundo do Documenso (SVG de 2,5 MB, sem uso) deu lugar ao material da faixa azul:
// grade de linhas finas de 24px (a mesma da barra lateral).
import { cn } from '@documenso/ui/lib/utils';
import type { CSSProperties, ReactNode } from 'react';

export const hairlineGridStyle: CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(0deg, rgba(255,255,255,.045) 0 1px, transparent 1px 24px), repeating-linear-gradient(90deg, rgba(255,255,255,.045) 0 1px, transparent 1px 24px)',
};

export type BrandBandProps = {
  children: ReactNode;
  className?: string;
};

/** Faixa azul de topo (celular nas telas de acesso; largura total em /verificar e nas telas de erro). */
export const BrandBand = ({ children, className }: BrandBandProps) => (
  <div
    className={cn('bg-shell px-6 pt-10 pb-14 text-shell-foreground', 'rounded-b-[26px]', className)}
    style={hairlineGridStyle}
  >
    {children}
  </div>
);
