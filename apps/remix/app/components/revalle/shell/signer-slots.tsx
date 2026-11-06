import { cn } from '@documenso/ui/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@documenso/ui/primitives/tooltip';

export type SignerSlotState = 'signed' | 'pending' | 'rejected' | 'you';

export type SignerSlot = {
  /** Nome completo ou e-mail; vira as iniciais do encaixe e o texto do tooltip. */
  name: string;
  state: SignerSlotState;
  /** Texto do tooltip depois do nome (ex.: "assinou em 05/11"). */
  detail?: string;
};

export type SignerSlotsProps = {
  slots: SignerSlot[];
  /** Encaixes visíveis antes do "+N". */
  max?: number;
  size?: 'sm' | 'md';
  className?: string;
};

const STATE_LABEL: Record<SignerSlotState, string> = {
  signed: 'assinou',
  pending: 'falta assinar',
  rejected: 'recusou',
  you: 'você',
};

/**
 * Os "encaixes" do engradado: um por destinatário que assina. Cheio = assinou, vazado = falta, riscado = recusou.
 * O estado é lido pela forma, não só pela cor (vale para daltônicos e para impressão).
 */
export const SignerSlots = ({ slots, max = 6, size = 'md', className }: SignerSlotsProps) => {
  const visible = slots.slice(0, max);
  const hidden = slots.length - visible.length;

  return (
    <div className={cn('flex flex-wrap items-center gap-[5px]', className)}>
      {visible.map((slot, index) => (
        <Tooltip key={`${slot.name}-${index}`}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`${slot.name}: ${slot.detail ?? STATE_LABEL[slot.state]}`}
              className={cn(
                'relative inline-grid place-items-center rounded-[10px] font-black font-display leading-none',
                size === 'sm' ? 'h-[26px] min-w-[26px] px-1 text-[10px]' : 'h-[30px] min-w-[30px] px-1.5 text-[11px]',
                slot.state === 'signed' &&
                  'bg-primary text-primary-foreground shadow-[inset_0_-3px_0_hsl(var(--brand-deep))]',
                slot.state === 'pending' && 'bg-card text-muted-foreground shadow-[inset_0_0_0_2px_hsl(var(--input))]',
                slot.state === 'you' && 'bg-accent px-2.5 text-brand-text shadow-[inset_0_0_0_2px_hsl(var(--primary))]',
                slot.state === 'rejected' &&
                  'bg-danger-bg text-destructive shadow-[inset_0_0_0_2px_hsl(var(--destructive))] after:absolute after:inset-x-1 after:top-1/2 after:h-[2px] after:-rotate-45 after:bg-destructive',
              )}
            >
              {slot.state === 'you' ? 'Você' : initials(slot.name)}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <span className="font-semibold">{slot.name}</span> · {slot.detail ?? STATE_LABEL[slot.state]}
          </TooltipContent>
        </Tooltip>
      ))}

      {hidden > 0 && <span className="px-1 font-bold text-[12px] text-muted-foreground">+{hidden}</span>}
    </div>
  );
};

const initials = (name: string) => {
  const clean = name.includes('@') ? name.split('@')[0].replace(/[._-]+/g, ' ') : name;
  const parts = clean.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return '?';
  }

  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
};
