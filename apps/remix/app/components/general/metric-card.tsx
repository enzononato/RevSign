import { cn } from '@documenso/ui/lib/utils';
import type { LucideIcon } from 'lucide-react/dist/lucide-react';

export type CardMetricProps = {
  icon?: LucideIcon;
  title: string;
  value?: string | number;
  className?: string;
  children?: React.ReactNode;
  testId?: string;
};

// REVALLE: v3-7a plain card with a display number: no decorative icon (the `icon` prop is kept for API compatibility)
export const CardMetric = ({ title, value, className, children, testId }: CardMetricProps) => {
  return (
    <div className={cn('max-w-full overflow-hidden rounded-card border border-border bg-card', className)}>
      <div className="flex h-full flex-col gap-3 p-5">
        <h3 className="font-medium text-muted-foreground text-sm leading-tight">{title}</h3>

        {children || (
          <p
            className="mt-auto font-black font-display text-[34px] text-foreground leading-none tracking-[-0.03em] [font-variant-numeric:tabular-nums]"
            data-testid={testId}
          >
            {typeof value === 'number' ? value.toLocaleString('en-US') : value}
          </p>
        )}
      </div>
    </div>
  );
};
