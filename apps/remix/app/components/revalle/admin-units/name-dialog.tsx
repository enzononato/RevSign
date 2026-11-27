import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@documenso/ui/primitives/dialog';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { Trans } from '@lingui/react/macro';
import { type ReactNode, useEffect, useId, useState } from 'react';

type UnitsNameDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  label: ReactNode;
  initialValue?: string;
  maxLength: number;
  submitLabel: ReactNode;
  loading?: boolean;
  onSubmit: (value: string) => void | Promise<void>;
  children?: ReactNode;
};

/** Diálogo de um campo de nome (nova unidade, novo time, renomear). Enter salva. */
export const UnitsNameDialog = ({
  open,
  onOpenChange,
  title,
  description,
  label,
  initialValue = '',
  maxLength,
  submitLabel,
  loading = false,
  onSubmit,
  children,
}: UnitsNameDialogProps) => {
  const inputId = useId();
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
    }
  }, [open, initialValue]);

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== initialValue.trim() && !loading;

  return (
    <Dialog open={open} onOpenChange={(next) => !loading && onOpenChange(next)}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();

            if (canSubmit) {
              void onSubmit(trimmed);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>

          <div className="mt-4 flex flex-col gap-2">
            <Label htmlFor={inputId}>{label}</Label>
            <Input
              id={inputId}
              value={value}
              maxLength={maxLength}
              autoFocus
              autoComplete="off"
              onChange={(event) => setValue(event.target.value)}
            />
          </div>

          {children}

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" disabled={loading} onClick={() => onOpenChange(false)}>
              <Trans>Cancelar</Trans>
            </Button>
            <Button type="submit" loading={loading} disabled={!canSubmit}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
