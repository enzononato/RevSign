import * as React from 'react';

import { cn } from '../lib/utils';

// REVALLE v3: redesign visual (tokens, pílula, raios); ver CHANGES.md

export type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  spotlight?: boolean;
  gradient?: boolean;
  degrees?: number;

  /**
   * Not sure if this is needed, but added a toggle so it defaults to true since that was how it was before.
   *
   * This is required to be set false if you want drag drop to work within this element.
   */
  backdropBlur?: boolean;
};

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, children, gradient = false, degrees = 120, backdropBlur = true, ...props }, ref) => {
    return (
      <div
        ref={ref}
        style={
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          {
            '--card-gradient-degrees': `${degrees}deg`,
          } as React.CSSProperties
        }
        className={cn(
          // REVALLE v3: cartão 20px, sombra de contorno em vez de borda dura
          'group relative rounded-card bg-card text-foreground shadow-card dark:shadow-[0_0_0_1px_hsl(var(--border))]',
          {
            'backdrop-blur-[2px]': backdropBlur,
            'gradient-border-mask before:pointer-events-none before:absolute before:-inset-[2px] before:rounded-card before:p-[2px] before:[background:linear-gradient(var(--card-gradient-degrees),theme(colors.primary.DEFAULT/50%)_5%,theme(colors.border/80%)_30%)]':
              gradient,
            'dark:gradient-border-mask before:pointer-events-none before:absolute before:-inset-[2px] before:rounded-card before:p-[2px] before:[background:linear-gradient(var(--card-gradient-degrees),theme(colors.primary.DEFAULT/70%)_5%,theme(colors.border/80%)_30%)]':
              gradient,
          },
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);

Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 p-6', className)} {...props} />
  ),
);

CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn('font-display font-extrabold text-lg leading-none tracking-[-0.02em]', className)}
      {...props}
    />
  ),
);

CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('text-muted-foreground text-sm', className)} {...props} />
  ),
);

CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('p-6 pt-0', className)} {...props} />,
);

CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center p-6 pt-0', className)} {...props} />
  ),
);

CardFooter.displayName = 'CardFooter';

export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
