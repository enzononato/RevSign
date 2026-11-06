import { cn } from '@documenso/ui/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@documenso/ui/primitives/tooltip';
import { useRef } from 'react';

export type SignerSlotState = 'signed' | 'pending' | 'rejected' | 'you';

export type SignerSlot = {
  /** Nome completo ou e-mail; vira as iniciais do encaixe e o texto do tooltip. */
  name: string;
  state: SignerSlotState;
  /** Texto do tooltip depois do nome (ex.: "assinou em 05/11"). */
  detail?: string;
  /**
   * REVALLE: o encaixe é de quem está vendo. Mostra "Você" no lugar das iniciais, com o desenho do estado
   * (`signed` + `isYou` = "Você" cheio, na tela de concluído). O estado `you` continua valendo como "você, falta".
   */
  isYou?: boolean;
  /** REVALLE: anima o preenchimento já na montagem (só a tela de concluído usa, no encaixe de quem acabou de assinar). */
  justFilled?: boolean;
};

export type SignerSlotsProps = {
  slots: SignerSlot[];
  /** Encaixes visíveis antes do "+N". */
  max?: number;
  /** REVALLE: `lg` é o encaixe de destaque da tela de concluído. */
  size?: 'sm' | 'md' | 'lg';
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
  const animated = useFillAnimation(visible);

  return (
    <div className={cn('flex flex-wrap items-center gap-[5px]', size === 'lg' && 'gap-2', className)}>
      {visible.map((slot, index) => {
        const isYou = slot.state === 'you' || slot.isYou;
        const label = slot.detail ?? STATE_LABEL[slot.state];

        return (
          <Tooltip key={`${slot.name}-${index}`}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={slot.name ? `${slot.name}: ${label}` : label}
                className={cn(
                  'relative inline-grid place-items-center rounded-[10px] font-black font-display leading-none',
                  // Área de toque de 44px sem mudar o desenho (o encaixe tem 26–30px).
                  "before:absolute before:-inset-[7px] before:content-['']",
                  size === 'sm' && 'h-[26px] min-w-[26px] px-1 text-[10px]',
                  size === 'md' && 'h-[30px] min-w-[30px] px-1.5 text-[11px]',
                  size === 'lg' && 'h-10 min-w-10 rounded-[12px] px-2 text-[13px]',
                  slot.state === 'signed' &&
                    'bg-primary text-primary-foreground shadow-[inset_0_-3px_0_hsl(var(--brand-deep))]',
                  slot.state === 'pending' &&
                    'bg-card text-muted-foreground shadow-[inset_0_0_0_2px_hsl(var(--input))]',
                  slot.state === 'you' && 'bg-accent text-brand-text shadow-[inset_0_0_0_2px_hsl(var(--primary))]',
                  isYou && (size === 'lg' ? 'px-3.5' : 'px-2.5'),
                  slot.state === 'rejected' &&
                    'bg-danger-bg text-destructive shadow-[inset_0_0_0_2px_hsl(var(--destructive))] after:absolute after:inset-x-1 after:top-1/2 after:h-[2px] after:-rotate-45 after:bg-destructive',
                  // REVALLE: o encaixe que acabou de encher. Entra de 0,8 e a tinta sobe de baixo, uma vez só (420 ms,
                  // ease-out exponencial). Sem nada com prefers-reduced-motion. Base vazada por baixo da tinta.
                  animated.has(index) &&
                    'motion-safe:zoom-in-[0.8] motion-safe:![animation-duration:420ms] motion-safe:![animation-timing-function:cubic-bezier(0.16,1,0.3,1)] motion-safe:animate-in motion-safe:bg-card motion-safe:shadow-[inset_0_0_0_2px_hsl(var(--input))]',
                )}
              >
                {animated.has(index) && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 hidden overflow-hidden rounded-[inherit] motion-safe:block"
                  >
                    <span className="slide-in-from-bottom-full ![animation-duration:420ms] ![animation-timing-function:cubic-bezier(0.16,1,0.3,1)] absolute inset-0 animate-in bg-primary shadow-[inset_0_-3px_0_hsl(var(--brand-deep))]" />
                  </span>
                )}
                <span className="relative">{isYou ? 'Você' : initials(slot.name)}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {slot.name ? (
                <>
                  <span className="font-semibold">{slot.name}</span> · {label}
                </>
              ) : (
                label
              )}
            </TooltipContent>
          </Tooltip>
        );
      })}

      {hidden > 0 && <span className="px-1 font-bold text-[12px] text-muted-foreground">+{hidden}</span>}
    </div>
  );
};

/**
 * REVALLE: quais encaixes tocam a animação de preenchimento. Um encaixe anima quando chega cheio (`signed`) e na
 * renderização anterior estava vazio (ex.: a lista recarregou e alguém assinou), ou quando vem com `justFilled`. Na
 * primeira renderização, só os `justFilled` (abrir a página não anima tudo de novo). Uma vez marcado, continua marcado:
 * tirar a classe no meio cortaria a animação.
 */
const useFillAnimation = (slots: SignerSlot[]) => {
  const previous = useRef<Map<string, boolean> | null>(null);
  const animatedKeys = useRef(new Set<string>());

  const current = new Map<string, boolean>();
  const animated = new Set<number>();

  slots.forEach((slot, index) => {
    const key = `${index}:${slot.name}`;
    const isFilled = slot.state === 'signed';
    const wasFilled = previous.current?.get(key);

    current.set(key, isFilled);

    if (isFilled && (slot.justFilled || wasFilled === false)) {
      animatedKeys.current.add(key);
    }

    if (!isFilled) {
      animatedKeys.current.delete(key);
    }

    if (animatedKeys.current.has(key)) {
      animated.add(index);
    }
  });

  previous.current = current;

  return animated;
};

const initials = (name: string) => {
  // REVALLE: sem nome (participante que ainda não assinou na página pública) = encaixe vazio, sem letras.
  if (!name.trim()) {
    return '';
  }

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
