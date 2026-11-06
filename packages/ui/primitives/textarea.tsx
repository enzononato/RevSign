import * as React from 'react';

import { cn } from '../lib/utils';

// REVALLE v3: redesign visual (tokens, pílula, raios); ver CHANGES.md

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        'flex h-20 w-full rounded-lg border-[1.5px] border-input bg-card px-3.5 py-2.5 text-base ring-offset-background placeholder:text-muted-foreground/60 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        className,
        {
          '!ring-destructive ring-2 transition-all': props['aria-invalid'],
        },
      )}
      ref={ref}
      {...props}
    />
  );
});

Textarea.displayName = 'Textarea';

export { Textarea };
