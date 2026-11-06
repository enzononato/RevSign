import { cn } from '@documenso/ui/lib/utils';
import type React from 'react';

export type SettingsHeaderProps = {
  title: string | React.ReactNode;
  subtitle: string | React.ReactNode;
  hideDivider?: boolean;
  children?: React.ReactNode;
  className?: string;
};

export const SettingsHeader = ({ children, title, subtitle, className, hideDivider }: SettingsHeaderProps) => {
  return (
    <>
      {/* REVALLE: v3-7a page header: display title, one muted line, pill actions on the right; the divider is a hairline rule */}
      <div className={cn('mb-5 flex flex-row flex-wrap items-center justify-between gap-3', className)}>
        <div className="min-w-0">
          <h2 className="font-black font-display text-[26px] leading-tight tracking-[-0.03em]">{title}</h2>

          <p className="mt-1 text-muted-foreground text-sm">{subtitle}</p>
        </div>

        {children}
      </div>

      {!hideDivider && <hr className="mb-6 border-border" />}
    </>
  );
};
