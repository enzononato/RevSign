import { Button } from '@documenso/ui/primitives/button';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@documenso/ui/primitives/dialog';
import { Label } from '@documenso/ui/primitives/label';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

type UnitScopeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personName: string;
  units: { organisationId: string; name: string }[];
  initialOrganisationIds: string[];
  loading?: boolean;
  onSubmit: (organisationIds: string[]) => void | Promise<void>;
};

/** Unidades que a pessoa do Financeiro ou da Contabilidade cobre (seleção múltipla). */
export const UnitScopeDialog = ({
  open,
  onOpenChange,
  personName,
  units,
  initialOrganisationIds,
  loading = false,
  onSubmit,
}: UnitScopeDialogProps) => {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open) {
      setSelected(new Set(initialOrganisationIds));
    }
  }, [open]);

  const toggle = (organisationId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);

      if (checked) {
        next.add(organisationId);
      } else {
        next.delete(organisationId);
      }

      return next;
    });
  };

  const allSelected = units.length > 0 && units.every((unit) => selected.has(unit.organisationId));

  return (
    <Dialog open={open} onOpenChange={(next) => !loading && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>Unidades de {personName}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              No Financeiro e na Contabilidade, a pessoa só vê e age nas notas fiscais das unidades marcadas. Sem
              nenhuma marcada, não vê nota nenhuma.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        {units.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed p-3 text-muted-foreground text-sm">
            <Trans>Ainda não há unidades. Crie as unidades primeiro.</Trans>
          </p>
        ) : (
          <>
            <div className="mt-2 flex justify-end">
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => setSelected(allSelected ? new Set() : new Set(units.map((unit) => unit.organisationId)))}
              >
                {allSelected ? <Trans>Desmarcar todas</Trans> : <Trans>Marcar todas</Trans>}
              </Button>
            </div>
            <ul className="max-h-72 overflow-y-auto rounded-lg border">
              {units.map((unit) => {
                const checkboxId = `unit-scope-${unit.organisationId}`;

                return (
                  <li key={unit.organisationId} className="flex items-center gap-3 border-t p-3 first:border-t-0">
                    <Checkbox
                      id={checkboxId}
                      checked={selected.has(unit.organisationId)}
                      onCheckedChange={(checked) => toggle(unit.organisationId, checked === true)}
                    />
                    <Label htmlFor={checkboxId} className="font-normal">
                      {unit.name}
                    </Label>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <DialogFooter className="mt-6">
          <Button type="button" variant="outline" disabled={loading} onClick={() => onOpenChange(false)}>
            <Trans>Cancelar</Trans>
          </Button>
          <Button type="button" loading={loading} onClick={() => void onSubmit([...selected])}>
            <Trans>Salvar unidades</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
