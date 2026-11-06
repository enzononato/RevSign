import type { ExtendedDocumentStatus } from '@documenso/prisma/types/extended-document-status';
import { SignatureIcon } from '@documenso/ui/icons/signature';
import { cn } from '@documenso/ui/lib/utils';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { CheckCircle2, Clock, File, TimerOff, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react/dist/lucide-react';
import type { HTMLAttributes } from 'react';

type FriendlyStatus = {
  label: MessageDescriptor;
  labelExtended: MessageDescriptor;
  icon?: LucideIcon;
  color: string;
  /** REVALLE v3: par de tokens da pílula de status (verde, âmbar, vermelho ou neutro; status nunca é azul). */
  pill: string;
};

// REVALLE v3: cores de status vindas dos tokens (pendente âmbar, concluído verde, recusado/cancelado vermelho).
export const FRIENDLY_STATUS_MAP: Record<ExtendedDocumentStatus, FriendlyStatus> = {
  PENDING: {
    label: msg`Pending`,
    labelExtended: msg`Document pending`,
    icon: Clock,
    color: 'text-warning-text',
    pill: 'bg-warning-bg text-warning-text',
  },
  COMPLETED: {
    label: msg`Completed`,
    labelExtended: msg`Document completed`,
    icon: CheckCircle2,
    color: 'text-success',
    pill: 'bg-success-bg text-success',
  },
  DRAFT: {
    label: msg`Draft`,
    labelExtended: msg`Document draft`,
    icon: File,
    color: 'text-muted-foreground',
    pill: 'bg-muted text-muted-foreground',
  },
  REJECTED: {
    label: msg`Rejected`,
    labelExtended: msg`Document rejected`,
    icon: XCircle,
    color: 'text-destructive',
    pill: 'bg-danger-bg text-destructive',
  },
  CANCELLED: {
    label: msg`Cancelled`,
    labelExtended: msg`Document cancelled`,
    icon: XCircle,
    color: 'text-destructive',
    pill: 'bg-danger-bg text-destructive',
  },
  EXPIRED: {
    label: msg`Expired`,
    labelExtended: msg`Document expired`,
    icon: TimerOff,
    color: 'text-warning-text',
    pill: 'bg-warning-bg text-warning-text',
  },
  INBOX: {
    label: msg`Inbox`,
    labelExtended: msg`Document inbox`,
    icon: SignatureIcon,
    color: 'text-muted-foreground',
    pill: 'bg-muted text-muted-foreground',
  },
  ALL: {
    label: msg`All`,
    labelExtended: msg`Document All`,
    color: 'text-muted-foreground',
    pill: 'bg-muted text-muted-foreground',
  },
};

export type DocumentStatusProps = HTMLAttributes<HTMLSpanElement> & {
  status: ExtendedDocumentStatus;
  inheritColor?: boolean;
  /** REVALLE v3: mostra o status como pílula (fundo + texto do mesmo par de tokens). */
  pill?: boolean;
};

export const DocumentStatus = ({ className, status, inheritColor, pill, ...props }: DocumentStatusProps) => {
  const { _ } = useLingui();

  const { label, icon: Icon, color, pill: pillColors } = FRIENDLY_STATUS_MAP[status];

  // REVALLE v3: pílula de status
  if (pill) {
    return (
      <span
        className={cn(
          'inline-flex h-7 w-fit items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 font-semibold text-[13px]',
          pillColors,
          className,
        )}
        {...props}
      >
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
        {_(label)}
      </span>
    );
  }

  return (
    <span className={cn('flex items-center', className)} {...props}>
      {Icon && (
        <Icon
          className={cn('mr-2 inline-block h-4 w-4', {
            [color]: !inheritColor,
          })}
        />
      )}
      {_(label)}
    </span>
  );
};
