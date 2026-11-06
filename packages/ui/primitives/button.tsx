import { Slot } from '@radix-ui/react-slot';
import type { VariantProps } from 'class-variance-authority';
import { cva } from 'class-variance-authority';
import { Loader } from 'lucide-react';
import * as React from 'react';

import { cn } from '../lib/utils';

// REVALLE v3: redesign visual (tokens, pílula, raios); ver CHANGES.md

const buttonVariants = cva(
  // REVALLE v3: botão pílula, 44px, ridge azul-escuro embaixo no primário
  'inline-flex items-center justify-center rounded-full text-[14.5px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none ring-offset-background',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-ridge hover:bg-primary/90 active:translate-y-px active:shadow-none',
        destructive:
          'bg-destructive text-destructive-foreground shadow-[0_2px_0_rgba(0,0,0,0.25)] hover:bg-destructive/90 focus-visible:ring-destructive active:translate-y-px active:shadow-none',
        outline: 'border-[1.5px] border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'underline-offset-4 hover:underline text-brand-text !rounded-sm',
        none: '',
      },
      size: {
        default: 'h-11 py-2 px-5',
        sm: 'h-9 px-4 text-sm',
        lg: 'h-[54px] px-8 text-base',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

const loaderVariants = cva('mr-2 animate-spin', {
  variants: {
    size: {
      default: 'h-5 w-5',
      sm: 'h-4 w-4',
      lg: 'h-5 w-5',
    },
  },
  defaultVariants: {
    size: 'default',
  },
});

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;

  /**
   * Will display the loading spinner and disable the button.
   */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading, ...props }, ref) => {
    if (asChild) {
      return <Slot className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
    }

    const isLoading = loading === true;
    const isDisabled = props.disabled || isLoading;

    return (
      <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} disabled={isDisabled}>
        {isLoading && <Loader className={cn('mr-2 animate-spin', loaderVariants({ size }))} />}
        {props.children}
      </button>
    );
  },
);

Button.displayName = 'Button';

export { Button, buttonVariants };
