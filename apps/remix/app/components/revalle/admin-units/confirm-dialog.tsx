import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@documenso/ui/primitives/alert-dialog';
import { Button } from '@documenso/ui/primitives/button';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

type UnitsConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: ReactNode;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
};

/** Confirmação antes de remover (time ou pessoa). O botão fica vermelho e mostra o carregando. */
export const UnitsConfirmDialog = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  loading = false,
  onConfirm,
}: UnitsConfirmDialogProps) => (
  <AlertDialog open={open} onOpenChange={(value) => !loading && onOpenChange(value)}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={loading}>
          <Trans>Cancelar</Trans>
        </AlertDialogCancel>
        <Button variant="destructive" loading={loading} onClick={() => void onConfirm()}>
          {confirmLabel}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);
