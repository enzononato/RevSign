import { cn } from '@documenso/ui/lib/utils';
import { type ReactNode, useEffect, useRef } from 'react';

export const StepHeading = ({ children, className }: { children: ReactNode; className?: string }) => {
  const ref = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <h1
      ref={ref}
      tabIndex={-1}
      className={cn(
        'font-black font-display text-[23px] leading-[1.2] tracking-[-0.02em] outline-none [text-wrap:balance] sm:text-[26px]',
        className,
      )}
    >
      {children}
    </h1>
  );
};
