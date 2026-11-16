import type { SerializedTimelineStep } from '@documenso/lib/revalle/receipts/recipient-stage';
import { cn } from '@documenso/ui/lib/utils';
import { CheckIcon, XIcon } from 'lucide-react';

export type RecipientSendTimelineProps = {
  steps: SerializedTimelineStep[];
  className?: string;
};

/**
 * REVALLE: os 3 passos de um destinatário (Enviado, Visualizado, Assinado ou Recusado), com o horário de Brasília de
 * cada um. Passo não alcançado fica cinza e vazado; recusado fica vermelho. O estado é lido pela forma, não só pela cor.
 */
export const RecipientSendTimeline = ({ steps, className }: RecipientSendTimelineProps) => {
  if (steps.length === 0) {
    return null;
  }

  return (
    <ol className={cn('flex flex-wrap items-start gap-x-3 gap-y-1.5', className)} data-testid="recipient-send-timeline">
      {steps.map((step) => {
        const isRejected = step.key === 'REJECTED';

        return (
          <li
            key={step.key}
            className="flex min-w-0 items-center gap-1.5"
            data-step={step.key}
            data-reached={step.reached ? 'true' : 'false'}
          >
            <span
              aria-hidden
              className={cn(
                'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
                !step.reached && 'shadow-[inset_0_0_0_1.5px_hsl(var(--input))]',
                step.reached && !isRejected && 'bg-primary text-primary-foreground',
                step.reached && isRejected && 'bg-destructive text-destructive-foreground',
              )}
            >
              {step.reached && (isRejected ? <XIcon className="h-2.5 w-2.5" /> : <CheckIcon className="h-2.5 w-2.5" />)}
            </span>
            <span
              className={cn('text-xs leading-tight', step.reached ? 'text-foreground' : 'text-muted-foreground/70')}
            >
              <span className={cn(step.reached && 'font-semibold', isRejected && 'text-destructive')}>
                {step.label}
              </span>
              {step.reached && step.atLabel && <span className="text-muted-foreground"> {step.atLabel}</span>}
              <span className="sr-only">{step.reached ? '' : ' (ainda não)'}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
};
