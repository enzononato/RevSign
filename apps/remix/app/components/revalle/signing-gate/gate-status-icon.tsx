import { cn } from '@documenso/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';

export type GateStatusIconProps = {
  icon: LucideIcon;
  tone: 'brand' | 'danger' | 'neutral' | 'success' | 'warning';
  className?: string;
};

/** Ícone de estado das telas de um cartão (bloqueado, indisponível, concluído...): círculo na cor do estado. */
export const GateStatusIcon = ({ icon: Icon, tone, className }: GateStatusIconProps) => (
  <span
    aria-hidden
    className={cn(
      'inline-grid h-14 w-14 flex-shrink-0 place-items-center rounded-full',
      tone === 'brand' && 'bg-accent text-brand-text',
      tone === 'danger' && 'bg-danger-bg text-destructive',
      tone === 'neutral' && 'bg-muted text-muted-foreground',
      tone === 'success' && 'bg-success-bg text-success',
      tone === 'warning' && 'bg-warning-bg text-warning-text',
      className,
    )}
  >
    <Icon className="h-7 w-7" strokeWidth={2.25} />
  </span>
);
