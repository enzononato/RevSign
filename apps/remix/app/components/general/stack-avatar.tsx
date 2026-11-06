import { RecipientStatusType } from '@documenso/lib/client-only/recipient-type';
import { cn } from '@documenso/ui/lib/utils';
import { Avatar, AvatarFallback } from '@documenso/ui/primitives/avatar';

const ZIndexes: { [key: string]: string } = {
  '10': 'z-10',
  '20': 'z-20',
  '30': 'z-30',
  '40': 'z-40',
  '50': 'z-50',
};

export type StackAvatarProps = {
  first?: boolean;
  zIndex?: string;
  fallbackText?: string;
  type: RecipientStatusType;
  className?: string;
};

export const StackAvatar = ({ first, zIndex, fallbackText = '', type, className }: StackAvatarProps) => {
  let classes = '';
  let zIndexClass = '';
  const firstClass = first ? '' : '-ml-3';

  if (zIndex) {
    zIndexClass = ZIndexes[zIndex] ?? '';
  }

  // REVALLE: redesign v3. Cores de status pelos tokens (funcionam no tema escuro); status nunca é azul.
  switch (type) {
    case RecipientStatusType.UNSIGNED:
      classes = 'bg-muted text-muted-foreground';
      break;
    case RecipientStatusType.OPENED:
      classes = 'bg-warning-bg text-warning-text';
      break;
    case RecipientStatusType.WAITING:
      classes = 'bg-warning-bg text-warning-text';
      break;
    case RecipientStatusType.COMPLETED:
      classes = 'bg-success-bg text-success';
      break;
    case RecipientStatusType.REJECTED:
      classes = 'bg-danger-bg text-destructive';
      break;
    default:
      break;
  }

  return (
    <Avatar
      className={cn(
        zIndexClass,
        firstClass,
        'h-10 w-10 border-2 border-card border-solid font-semibold', // REVALLE: borda na cor do cartão
        className,
      )}
    >
      <AvatarFallback className={classes}>{fallbackText}</AvatarFallback>
    </Avatar>
  );
};
