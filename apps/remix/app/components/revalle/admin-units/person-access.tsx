import { trpc } from '@documenso/trpc/react';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import { Switch } from '@documenso/ui/primitives/switch';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangleIcon, Building2Icon } from 'lucide-react';
import { useId, useState } from 'react';

import { UnitScopeDialog } from './unit-scope-dialog';
import { useUnitsErrorToast } from './use-units-error';

export type PersonAccess = {
  userId: number;
  name: string | null;
  email: string;
  ownOnly: boolean;
  isFinanceMember: boolean;
  isAccountingMember: boolean;
  scopeOrganisationIds: string[];
};

type UnitOption = { organisationId: string; name: string };

/** Interruptor "ver só o seu" de uma pessoa. */
export const OwnOnlySwitch = ({ person, onChanged }: { person: PersonAccess; onChanged: () => unknown }) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const showError = useUnitsErrorToast();
  const switchId = useId();

  const { mutateAsync, isPending } = trpc.revalle.units.setOwnOnly.useMutation();

  const personName = person.name?.trim() || person.email;

  const onToggle = async (ownOnly: boolean) => {
    try {
      await mutateAsync({ userId: person.userId, ownOnly });
      toast({
        title: ownOnly
          ? t`${personName} agora vê só o que enviou ou recebeu para assinar.`
          : t`${personName} volta a ver os documentos dos times dela.`,
      });
      await onChanged();
    } catch (error) {
      showError(error);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Switch
        id={switchId}
        checked={person.ownOnly}
        disabled={isPending}
        aria-label={t`Ver só o que enviou ou recebeu para assinar`}
        onCheckedChange={(checked) => void onToggle(checked)}
      />
      <label htmlFor={switchId} className="text-sm">
        <Trans>Ver só o que enviou ou recebeu para assinar</Trans>
      </label>
    </div>
  );
};

/** Para quem é do Financeiro ou da Contabilidade: as unidades que cobre, com o aviso quando não há nenhuma. */
export const UnitScopeControl = ({
  person,
  units,
  onChanged,
}: {
  person: PersonAccess;
  units: UnitOption[];
  onChanged: () => unknown;
}) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const showError = useUnitsErrorToast();
  const [open, setOpen] = useState(false);

  const { mutateAsync, isPending } = trpc.revalle.units.setScope.useMutation();

  if (!person.isFinanceMember && !person.isAccountingMember) {
    return null;
  }

  const personName = person.name?.trim() || person.email;
  const names = units
    .filter((unit) => person.scopeOrganisationIds.includes(unit.organisationId))
    .map((unit) => unit.name);

  const onSubmit = async (organisationIds: string[]) => {
    try {
      await mutateAsync({ userId: person.userId, organisationIds });
      toast({ title: t`Unidades de ${personName} salvas.` });
      setOpen(false);
      await onChanged();
    } catch (error) {
      showError(error);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {person.isFinanceMember && (
          <Badge variant="secondary" size="small">
            <Trans>Financeiro</Trans>
          </Badge>
        )}
        {person.isAccountingMember && (
          <Badge variant="secondary" size="small">
            <Trans>Contabilidade</Trans>
          </Badge>
        )}
      </div>

      {names.length === 0 ? (
        <p className="flex items-center gap-1.5 text-sm text-warning-text" data-testid="unit-scope-empty">
          <AlertTriangleIcon className="h-4 w-4 shrink-0" />
          <Trans>Sem unidades: escolha as unidades desta pessoa</Trans>
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">
          <Building2Icon className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
          {names.join(', ')}
        </p>
      )}

      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setOpen(true)}>
        <Trans>Escolher unidades</Trans>
      </Button>

      <UnitScopeDialog
        open={open}
        onOpenChange={setOpen}
        personName={personName}
        units={units}
        initialOrganisationIds={person.scopeOrganisationIds}
        loading={isPending}
        onSubmit={onSubmit}
      />
    </div>
  );
};
