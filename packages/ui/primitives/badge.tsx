import type { VariantProps } from 'class-variance-authority';
import { cva } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from '../lib/utils';

// REVALLE v3: redesign visual (tokens, pílula, raios); ver CHANGES.md

// REVALLE v3: pílula com cores de status vindas dos tokens (texto ≥ 4,5:1 sobre o fundo)
const badgeVariants = cva('inline-flex items-center rounded-full text-xs font-semibold w-fit', {
  variants: {
    variant: {
      neutral: 'bg-muted text-muted-foreground',
      destructive: 'bg-danger-bg text-destructive',
      warning: 'bg-warning-bg text-warning-text',
      default: 'bg-success-bg text-success',
      secondary: 'bg-accent text-accent-foreground',
      orange: 'bg-warning-bg text-warning-text',
    },
    size: {
      small: 'px-2 py-0.5 text-xs',
      default: 'px-2.5 py-1 text-xs',
      large: 'px-3.5 py-1.5 text-sm',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <div role="status" className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

export { Badge, badgeVariants };
