import type { VariantProps } from 'class-variance-authority';
import { cva } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '../lib/utils';

// REVALLE v3: redesign visual (tokens, pílula, raios); ver CHANGES.md

// REVALLE v3: cores de status via tokens
const alertVariants = cva(
  'relative w-full rounded-lg border p-4 [&>svg]:absolute [&>svg]:text-foreground [&>svg]:left-4 [&>svg]:top-4 [&>svg+div]:translate-y-[-3px] [&>svg~*]:pl-8',
  {
    variants: {
      variant: {
        default: 'border-success/20 bg-success-bg text-success [&_.alert-title]:text-success [&>svg]:text-success',
        neutral: 'border-border bg-muted text-muted-foreground [&_.alert-title]:text-foreground',
        secondary:
          'border-border bg-accent text-accent-foreground [&_.alert-title]:text-accent-foreground [&>svg]:text-accent-foreground',
        destructive:
          'border-destructive/20 bg-danger-bg text-destructive [&_.alert-title]:text-destructive [&>svg]:text-destructive',
        warning:
          'border-warning-text/20 bg-warning-bg text-warning-text [&_.alert-title]:text-warning-text [&>svg]:text-warning-text',
      },
      padding: {
        tighter: 'p-2',
        tight: 'px-4 py-2',
        default: 'p-4',
      },
    },
    defaultVariants: {
      variant: 'default',
      padding: 'default',
    },
  },
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, padding, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn('space-y-2', alertVariants({ variant, padding }), className)} {...props} />
));

Alert.displayName = 'Alert';

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5 ref={ref} className={cn('alert-title font-medium text-base', className)} {...props} />
  ),
);

AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('text-sm', className)} {...props} />,
);

AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertDescription, AlertTitle };
