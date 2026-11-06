import { cn } from '@documenso/ui/lib/utils';
import { Skeleton } from '@documenso/ui/primitives/skeleton';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

export type DocumentRowCardProps = {
  title: ReactNode;
  meta?: ReactNode;
  slots?: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
  menu?: ReactNode;
  select?: ReactNode;
  isSelected?: boolean;
};

/**
 * REVALLE v3: a linha das listas de documentos no celular vira um cartão (título, quem enviou e quando, encaixes e
 * status, ação na largura toda). No computador as listas continuam em tabela.
 */
export const DocumentRowCard = ({
  title,
  meta,
  slots,
  status,
  action,
  menu,
  select,
  isSelected,
}: DocumentRowCardProps) => (
  <li
    className={cn('min-w-0 rounded-card bg-card p-4 shadow-card', isSelected && 'ring-2 ring-primary ring-inset')}
    data-testid="document-row-card"
  >
    <div className="flex items-start gap-3">
      {select && <div className="flex h-6 shrink-0 items-center">{select}</div>}

      <div className="min-w-0 flex-1">
        <div className="break-words font-bold text-[15.5px] leading-snug">{title}</div>
        {meta && <p className="mt-1 break-words text-[13px] text-muted-foreground">{meta}</p>}
      </div>

      {menu && <div className="-mt-1 -mr-1 flex shrink-0 items-center">{menu}</div>}
    </div>

    {(slots || status) && (
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">{slots}</div>
        {status}
      </div>
    )}

    {action && <div className="mt-3 empty:hidden [&_a]:w-full [&_button]:w-full">{action}</div>}
  </li>
);

export const DocumentRowCardList = ({ children }: { children: ReactNode }) => (
  <ul className="flex flex-col gap-2.5 md:hidden">{children}</ul>
);

export const DocumentRowCardSkeletons = ({ count = 3 }: { count?: number }) => (
  <DocumentRowCardList>
    {Array.from({ length: count }).map((_, index) => (
      <li key={index} className="rounded-card bg-card p-4 shadow-card">
        <Skeleton className="h-4 w-3/4 rounded-full" />
        <Skeleton className="mt-2 h-3 w-1/2 rounded-full" />
        <div className="mt-4 flex gap-1.5">
          <Skeleton className="h-[30px] w-[30px] rounded-[10px]" />
          <Skeleton className="h-[30px] w-[30px] rounded-[10px]" />
        </div>
        <Skeleton className="mt-4 h-11 w-full rounded-full" />
      </li>
    ))}
  </DocumentRowCardList>
);

export const DocumentRowCardError = () => (
  <p className="rounded-card bg-card p-6 text-center text-muted-foreground text-sm shadow-card md:hidden">
    <Trans>Something went wrong.</Trans>
  </p>
);
