import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import { Label } from '@documenso/ui/primitives/label';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Building2Icon, ChevronRightIcon, PlusIcon, SparklesIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { UnitsNameDialog } from '~/components/revalle/admin-units/name-dialog';
import { OwnOnlySwitch, UnitScopeControl } from '~/components/revalle/admin-units/person-access';
import { useUnitsErrorToast } from '~/components/revalle/admin-units/use-units-error';
import { appMetaTags } from '~/utils/meta';

export function meta() {
  return appMetaTags(msg`Unidades e times`);
}

const ProfilesSection = ({ units }: { units: { organisationId: string; name: string }[] }) => {
  const { data, isPending, isError, refetch } = trpc.revalle.units.listProfiles.useQuery();
  const users = data?.users ?? [];

  return (
    <section className="mt-10" aria-labelledby="units-profiles-title">
      <h3 id="units-profiles-title" className="font-bold font-display text-xl tracking-[-0.02em]">
        <Trans>Financeiro e Contabilidade</Trans>
      </h3>
      <p className="mt-1 max-w-2xl text-muted-foreground text-sm">
        <Trans>
          Quem é do Financeiro ou da Contabilidade só vê e age nas notas fiscais das unidades escolhidas aqui. Os perfis
          são marcados em Admin → Perfis.
        </Trans>
      </p>

      <div className="mt-4 overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/60 font-semibold text-muted-foreground text-xs uppercase tracking-[0.04em]">
            <tr>
              <th className="p-3 font-semibold">
                <Trans>Pessoa</Trans>
              </th>
              <th className="p-3 font-semibold">
                <Trans>Unidades que cobre</Trans>
              </th>
              <th className="p-3 font-semibold">
                <Trans>Visibilidade</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {isPending &&
              Array.from({ length: 3 }, (_, index) => (
                <tr key={`skeleton-${index}`} className="border-t" aria-hidden>
                  <td className="p-3">
                    <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                  </td>
                  <td className="p-3">
                    <div className="h-4 w-48 animate-pulse rounded bg-muted" />
                  </td>
                  <td className="p-3">
                    <div className="h-6 w-11 animate-pulse rounded-full bg-muted" />
                  </td>
                </tr>
              ))}
            {users.map((user) => (
              <tr key={user.userId} className="border-t align-top">
                <td className="p-3">
                  <p className="font-medium">{user.name?.trim() || user.email}</p>
                  <p className="text-muted-foreground">{user.email}</p>
                  {user.disabled && (
                    <p className="mt-1 text-muted-foreground text-xs">
                      <Trans>Conta desativada</Trans>
                    </p>
                  )}
                </td>
                <td className="p-3">
                  <UnitScopeControl person={user} units={units} onChanged={refetch} />
                </td>
                <td className="p-3">
                  <OwnOnlySwitch person={user} onChanged={refetch} />
                </td>
              </tr>
            ))}
            {!isPending && !isError && users.length === 0 && (
              <tr>
                <td colSpan={3} className="p-4 text-center text-muted-foreground">
                  <Trans>Ninguém marcado como Financeiro ou Contabilidade. Marque em Admin → Perfis.</Trans>
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={3} className="p-4 text-center text-muted-foreground">
                  <Trans>Não foi possível carregar. Tente de novo.</Trans>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default function AdminUnidadesPage() {
  const { t } = useLingui();
  const { toast } = useToast();
  const showError = useUnitsErrorToast();
  const navigate = useNavigate();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [withHrTeams, setWithHrTeams] = useState(true);

  const { data, isPending, isError, refetch } = trpc.revalle.units.list.useQuery();
  const { mutateAsync: createDefaults, isPending: isCreatingDefaults } =
    trpc.revalle.units.createDefaults.useMutation();
  const { mutateAsync: createUnit, isPending: isCreating } = trpc.revalle.units.create.useMutation();

  const units = data?.units ?? [];
  const missing = data?.missingDefaultUnits ?? [];
  const missingCount = missing.length;

  const onCreateDefaults = async () => {
    try {
      const result = await createDefaults();
      const createdCount = result.created.length;
      const teamsCount = result.teamsCreated;

      toast({
        title:
          createdCount > 0
            ? t`Unidades criadas: ${createdCount}. Times criados a partir do RH: ${teamsCount}.`
            : t`As 7 unidades já existiam. Times novos a partir do RH: ${teamsCount}.`,
        description: result.hrAvailable
          ? undefined
          : t`A base do RH não respondeu: as unidades ficaram sem times. Tente "Criar times a partir dos setores do RH" depois.`,
      });
      await refetch();
    } catch (error) {
      showError(error);
    }
  };

  const onCreate = async (name: string) => {
    try {
      const result = await createUnit({ name, createTeamsFromHr: withHrTeams });
      const teamsCount = result.teamsCreated;

      toast({
        title: t`Unidade ${name} criada.`,
        description:
          result.hrAvailable === false
            ? t`A base do RH não respondeu: crie os times depois.`
            : withHrTeams
              ? t`Times criados a partir do RH: ${teamsCount}.`
              : undefined,
      });
      setIsCreateOpen(false);
      await navigate(`/admin/unidades/${result.organisationId}`);
    } catch (error) {
      showError(error);
    }
  };

  return (
    <div>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="font-black font-display text-[26px] leading-tight tracking-[-0.03em]">
            <Trans>Unidades e times</Trans>
          </h2>
          <p className="mt-2 max-w-2xl text-muted-foreground text-sm">
            <Trans>
              Cada unidade é uma organização com os times dos setores. As pessoas entram como membro e só veem os
              documentos dos times delas.
            </Trans>
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {missingCount > 0 && units.length > 0 && (
            <Button variant="outline" loading={isCreatingDefaults} onClick={() => void onCreateDefaults()}>
              <SparklesIcon className="mr-2 h-4 w-4" />
              <Trans>Criar as que faltam ({missingCount})</Trans>
            </Button>
          )}
          <Button onClick={() => setIsCreateOpen(true)}>
            <PlusIcon className="mr-2 h-4 w-4" />
            <Trans>Nova unidade</Trans>
          </Button>
        </div>
      </div>

      {isPending && (
        <div className="mt-6 grid gap-3 sm:grid-cols-2" aria-hidden>
          {Array.from({ length: 4 }, (_, index) => (
            <div key={`skeleton-${index}`} className="h-24 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      )}

      {isError && (
        <div className="mt-6 rounded-lg border p-6 text-center text-muted-foreground text-sm">
          <p>
            <Trans>Não foi possível carregar as unidades.</Trans>
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
            <Trans>Tentar de novo</Trans>
          </Button>
        </div>
      )}

      {!isPending && !isError && units.length === 0 && (
        <div className="mt-6 flex flex-col items-center rounded-lg border border-dashed p-8 text-center">
          <Building2Icon className="h-10 w-10 text-muted-foreground" />
          <p className="mt-3 font-semibold">
            <Trans>Nenhuma unidade ainda</Trans>
          </p>
          <p className="mt-1 max-w-md text-muted-foreground text-sm">
            <Trans>
              Comece pelas 7 unidades: Juazeiro, Bonfim, Petrolina, Ribeira do Pombal, Paulo Afonso, Alagoinhas e
              Serrinha. Os times nascem dos setores de cada unidade na base do RH.
            </Trans>
          </p>
          <Button className="mt-5" loading={isCreatingDefaults} onClick={() => void onCreateDefaults()}>
            <SparklesIcon className="mr-2 h-4 w-4" />
            <Trans>Criar as 7 unidades</Trans>
          </Button>
        </div>
      )}

      {units.length > 0 && (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {units.map((unit) => {
            const teamCount = unit.teamCount;
            const memberCount = unit.memberCount;

            return (
              <li key={unit.organisationId}>
                <Link
                  to={`/admin/unidades/${unit.organisationId}`}
                  className="flex items-center justify-between gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/60"
                >
                  <div className="min-w-0">
                    <p className="truncate font-bold font-display text-lg tracking-[-0.02em]">{unit.name}</p>
                    <p className="mt-1 text-muted-foreground text-sm">
                      <Trans>
                        Times: {teamCount} · Pessoas: {memberCount}
                      </Trans>
                    </p>
                  </div>
                  <ChevronRightIcon className="h-5 w-5 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <ProfilesSection units={units.map((unit) => ({ organisationId: unit.organisationId, name: unit.name }))} />

      <UnitsNameDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        title={<Trans>Nova unidade</Trans>}
        description={<Trans>Use o mesmo nome da unidade na base do RH, para os times virem dos setores dela.</Trans>}
        label={<Trans>Nome da unidade</Trans>}
        maxLength={80}
        submitLabel={<Trans>Criar unidade</Trans>}
        loading={isCreating}
        onSubmit={onCreate}
      >
        <div className="mt-4 flex items-center gap-2">
          <Checkbox
            id="unit-create-hr-teams"
            checked={withHrTeams}
            onCheckedChange={(checked) => setWithHrTeams(checked === true)}
          />
          <Label htmlFor="unit-create-hr-teams" className="font-normal">
            <Trans>Criar times a partir dos setores do RH</Trans>
          </Label>
        </div>
      </UnitsNameDialog>
    </div>
  );
}
