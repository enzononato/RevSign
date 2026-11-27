import { trpc } from '@documenso/trpc/react';
import type { TUnitsGetResponse } from '@documenso/trpc/server/revalle-router/units/schema';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@documenso/ui/primitives/tooltip';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  ArrowLeftIcon,
  DatabaseIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UserMinusIcon,
  UserPlusIcon,
  UsersIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { UnitsConfirmDialog } from '~/components/revalle/admin-units/confirm-dialog';
import { MemberTeamsDialog, type UnitTeamRole } from '~/components/revalle/admin-units/member-teams-dialog';
import { UnitsNameDialog } from '~/components/revalle/admin-units/name-dialog';
import { OwnOnlySwitch, UnitScopeControl } from '~/components/revalle/admin-units/person-access';
import { useUnitsErrorToast } from '~/components/revalle/admin-units/use-units-error';
import { appMetaTags } from '~/utils/meta';

export function meta() {
  return appMetaTags(msg`Unidades e times`);
}

type Team = TUnitsGetResponse['teams'][number];
type Member = TUnitsGetResponse['members'][number];

const personName = (member: Pick<Member, 'name' | 'email'>) => member.name?.trim() || member.email;

export default function AdminUnidadePage() {
  const { id = '' } = useParams();
  const { t } = useLingui();
  const { toast } = useToast();
  const showError = useUnitsErrorToast();

  const [isRenameUnitOpen, setIsRenameUnitOpen] = useState(false);
  const [isNewTeamOpen, setIsNewTeamOpen] = useState(false);
  const [teamToRename, setTeamToRename] = useState<Team | null>(null);
  const [teamToDelete, setTeamToDelete] = useState<Team | null>(null);
  const [isAddMemberOpen, setIsAddMemberOpen] = useState(false);
  const [memberToEdit, setMemberToEdit] = useState<Member | null>(null);
  const [memberToRemove, setMemberToRemove] = useState<Member | null>(null);

  const { data, isPending, isError, error, refetch } = trpc.revalle.units.get.useQuery(
    { organisationId: id },
    { enabled: id.length > 0 },
  );
  const { data: listData, refetch: refetchList } = trpc.revalle.units.list.useQuery();

  const renameUnit = trpc.revalle.units.rename.useMutation();
  const createTeamsFromHr = trpc.revalle.units.createTeamsFromHr.useMutation();
  const createTeam = trpc.revalle.units.createTeam.useMutation();
  const renameTeam = trpc.revalle.units.renameTeam.useMutation();
  const deleteTeam = trpc.revalle.units.deleteTeam.useMutation();
  const addMember = trpc.revalle.units.addMember.useMutation();
  const setMemberTeams = trpc.revalle.units.setMemberTeams.useMutation();
  const removeMember = trpc.revalle.units.removeMember.useMutation();

  const refresh = async () => {
    await Promise.all([refetch(), refetchList()]);
  };

  const units = (listData?.units ?? []).map((unit) => ({ organisationId: unit.organisationId, name: unit.name }));

  if (isError && error?.data?.code === 'NOT_FOUND') {
    return (
      <div className="flex flex-col items-start gap-3">
        <h2 className="font-black font-display text-[26px] leading-tight tracking-[-0.03em]">
          <Trans>Unidade não encontrada</Trans>
        </h2>
        <p className="text-muted-foreground text-sm">
          <Trans>Ela pode ter sido apagada. Volte para a lista de unidades.</Trans>
        </p>
        <Button asChild variant="outline">
          <Link to="/admin/unidades">
            <ArrowLeftIcon className="mr-2 h-4 w-4" />
            <Trans>Unidades e times</Trans>
          </Link>
        </Button>
      </div>
    );
  }

  if (isPending || !data) {
    return (
      <div aria-hidden className="flex flex-col gap-4">
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
        <div className="h-40 animate-pulse rounded-lg bg-muted" />
        <div className="h-40 animate-pulse rounded-lg bg-muted" />
        {isError && (
          <Button variant="outline" size="sm" className="w-fit" onClick={() => void refetch()}>
            <Trans>Tentar de novo</Trans>
          </Button>
        )}
      </div>
    );
  }

  const { unit, teams, members } = data;
  const unitName = unit.name;
  const hrUnitName = unit.hrUnitName;
  const teamNameById = new Map(teams.map((team) => [team.id, team.name]));

  const onRenameUnit = async (name: string) => {
    try {
      await renameUnit.mutateAsync({ organisationId: unit.organisationId, name });
      toast({ title: t`Unidade renomeada para ${name}.` });
      setIsRenameUnitOpen(false);
      await refresh();
    } catch (err) {
      showError(err);
    }
  };

  const onCreateTeamsFromHr = async () => {
    try {
      const result = await createTeamsFromHr.mutateAsync({ organisationId: unit.organisationId });
      const createdCount = result.created.length;
      const setorCount = result.setorCount;

      if (!result.hrAvailable) {
        toast({
          title: t`A base do RH não respondeu. Nada foi criado; tente de novo mais tarde.`,
          variant: 'destructive',
        });
      } else if (setorCount === 0) {
        toast({ title: t`A base do RH não tem setores para ${unitName}. Confira o nome da unidade no RH.` });
      } else if (createdCount === 0) {
        toast({ title: t`Todos os setores do RH já têm time (${setorCount}).` });
      } else {
        toast({ title: t`Times criados a partir do RH: ${createdCount}.` });
      }

      await refresh();
    } catch (err) {
      showError(err);
    }
  };

  const onCreateTeam = async (name: string) => {
    try {
      await createTeam.mutateAsync({ organisationId: unit.organisationId, name });
      toast({ title: t`Time ${name} criado.` });
      setIsNewTeamOpen(false);
      await refresh();
    } catch (err) {
      showError(err);
    }
  };

  const onRenameTeam = async (name: string) => {
    if (!teamToRename) {
      return;
    }

    try {
      await renameTeam.mutateAsync({ teamId: teamToRename.id, name });
      toast({ title: t`Time renomeado para ${name}.` });
      setTeamToRename(null);
      await refresh();
    } catch (err) {
      showError(err);
    }
  };

  const onDeleteTeam = async () => {
    if (!teamToDelete) {
      return;
    }

    const teamName = teamToDelete.name;

    try {
      await deleteTeam.mutateAsync({ teamId: teamToDelete.id });
      toast({ title: t`Time ${teamName} removido.` });
      setTeamToDelete(null);
      await refresh();
    } catch (err) {
      showError(err);
    }
  };

  const onAddMember = async (input: { userId: number; teams: { teamId: number; role?: UnitTeamRole }[] }) => {
    try {
      await addMember.mutateAsync({ organisationId: unit.organisationId, ...input });
      toast({ title: t`Pessoa adicionada em ${unitName}.` });
      setIsAddMemberOpen(false);
      await refresh();
    } catch (err) {
      showError(err);
    }
  };

  const onSetMemberTeams = async (input: { userId: number; teams: { teamId: number; role?: UnitTeamRole }[] }) => {
    try {
      await setMemberTeams.mutateAsync({ organisationId: unit.organisationId, ...input });
      toast({ title: t`Times salvos.` });
      setMemberToEdit(null);
      await refresh();
    } catch (err) {
      showError(err);
    }
  };

  const onRemoveMember = async () => {
    if (!memberToRemove) {
      return;
    }

    const name = personName(memberToRemove);

    try {
      await removeMember.mutateAsync({ organisationId: unit.organisationId, userId: memberToRemove.userId });
      toast({ title: t`${name} saiu de ${unitName}.` });
      setMemberToRemove(null);
      await refresh();
    } catch (err) {
      showError(err);
    }
  };

  const teamToDeleteName = teamToDelete?.name ?? '';
  const memberToRemoveName = memberToRemove ? personName(memberToRemove) : '';

  return (
    <div>
      <Link
        to="/admin/unidades"
        className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeftIcon className="h-4 w-4" />
        <Trans>Unidades e times</Trans>
      </Link>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <h2 className="font-black font-display text-[26px] leading-tight tracking-[-0.03em]">{unitName}</h2>
        <Button variant="ghost" size="sm" aria-label={t`Renomear unidade`} onClick={() => setIsRenameUnitOpen(true)}>
          <PencilIcon className="h-4 w-4" />
        </Button>
      </div>
      <p className="mt-1 text-muted-foreground text-sm">
        <Trans>Nome na base do RH: {hrUnitName}</Trans>
      </p>

      {/* Times */}
      <section className="mt-8" aria-labelledby="unit-teams-title">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <h3 id="unit-teams-title" className="font-bold font-display text-xl tracking-[-0.02em]">
            <Trans>Times</Trans>
          </h3>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" loading={createTeamsFromHr.isPending} onClick={() => void onCreateTeamsFromHr()}>
              <DatabaseIcon className="mr-2 h-4 w-4" />
              <Trans>Criar times a partir dos setores do RH</Trans>
            </Button>
            <Button onClick={() => setIsNewTeamOpen(true)}>
              <PlusIcon className="mr-2 h-4 w-4" />
              <Trans>Novo time</Trans>
            </Button>
          </div>
        </div>

        {teams.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
            <Trans>Nenhum time ainda. Crie a partir dos setores do RH ou um por um em "Novo time".</Trans>
          </div>
        ) : (
          <ul className="mt-4 divide-y rounded-lg border">
            {teams.map((team) => {
              const memberCount = team.memberCount;
              const envelopeCount = team.envelopeCount;
              const hasDocuments = envelopeCount > 0;

              return (
                <li key={team.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{team.name}</p>
                    <p className="text-muted-foreground text-xs">
                      <Trans>
                        Pessoas: {memberCount} · Documentos: {envelopeCount}
                      </Trans>
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setTeamToRename(team)}>
                      <PencilIcon className="mr-1.5 h-4 w-4" />
                      <Trans>Renomear</Trans>
                    </Button>
                    {hasDocuments ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <Button variant="ghost" size="sm" disabled>
                              <Trash2Icon className="mr-1.5 h-4 w-4" />
                              <Trans>Remover</Trans>
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <Trans>Time com documentos não pode ser removido.</Trans>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setTeamToDelete(team)}
                      >
                        <Trash2Icon className="mr-1.5 h-4 w-4" />
                        <Trans>Remover</Trans>
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Pessoas */}
      <section className="mt-10" aria-labelledby="unit-members-title">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <h3 id="unit-members-title" className="font-bold font-display text-xl tracking-[-0.02em]">
            <Trans>Pessoas</Trans>
          </h3>
          <Button onClick={() => setIsAddMemberOpen(true)}>
            <UserPlusIcon className="mr-2 h-4 w-4" />
            <Trans>Adicionar pessoa</Trans>
          </Button>
        </div>

        {members.length === 0 ? (
          <div className="mt-4 flex flex-col items-center rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
            <UsersIcon className="h-8 w-8" />
            <p className="mt-2">
              <Trans>Ninguém nesta unidade ainda. Adicione quem já tem conta.</Trans>
            </p>
          </div>
        ) : (
          <ul className="mt-4 divide-y rounded-lg border">
            {members.map((member) => {
              const isUnitAdmin = member.organisationRole !== 'MEMBER';

              return (
                <li key={member.organisationMemberId} className="flex flex-col gap-3 p-4" data-testid="unit-member">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{personName(member)}</p>
                      <p className="truncate text-muted-foreground text-sm">{member.email}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {member.isOwner && (
                          <Badge variant="neutral" size="small">
                            <Trans>Criou a unidade</Trans>
                          </Badge>
                        )}
                        {isUnitAdmin && (
                          <Badge variant="neutral" size="small">
                            <Trans>Administra a unidade (todos os times)</Trans>
                          </Badge>
                        )}
                        {member.disabled && (
                          <Badge variant="warning" size="small">
                            <Trans>Conta desativada</Trans>
                          </Badge>
                        )}
                        {member.teams.map((choice) => (
                          <Badge key={choice.teamId} variant="secondary" size="small">
                            {teamNameById.get(choice.teamId) ?? '-'}
                            {choice.role === 'MANAGER' && (
                              <span className="ml-1 font-normal">
                                (<Trans>gerente</Trans>)
                              </span>
                            )}
                            {choice.role === 'ADMIN' && (
                              <span className="ml-1 font-normal">
                                (<Trans>admin</Trans>)
                              </span>
                            )}
                          </Badge>
                        ))}
                        {!isUnitAdmin && member.teams.length === 0 && (
                          <span className="text-sm text-warning-text">
                            <Trans>Sem time: ainda não vê documentos da unidade.</Trans>
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 gap-1">
                      <Button variant="outline" size="sm" onClick={() => setMemberToEdit(member)}>
                        <UsersIcon className="mr-1.5 h-4 w-4" />
                        <Trans>Times</Trans>
                      </Button>
                      {!member.isOwner && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setMemberToRemove(member)}
                        >
                          <UserMinusIcon className="mr-1.5 h-4 w-4" />
                          <Trans>Tirar da unidade</Trans>
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-8">
                    <OwnOnlySwitch person={member} onChanged={refresh} />
                    <UnitScopeControl person={member} units={units} onChanged={refresh} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <UnitsNameDialog
        open={isRenameUnitOpen}
        onOpenChange={setIsRenameUnitOpen}
        title={<Trans>Renomear unidade</Trans>}
        description={<Trans>Muda só o nome que aparece. O nome na base do RH continua o mesmo.</Trans>}
        label={<Trans>Nome da unidade</Trans>}
        initialValue={unitName}
        maxLength={80}
        submitLabel={<Trans>Salvar</Trans>}
        loading={renameUnit.isPending}
        onSubmit={onRenameUnit}
      />

      <UnitsNameDialog
        open={isNewTeamOpen}
        onOpenChange={setIsNewTeamOpen}
        title={<Trans>Novo time em {unitName}</Trans>}
        label={<Trans>Nome do time</Trans>}
        maxLength={60}
        submitLabel={<Trans>Criar time</Trans>}
        loading={createTeam.isPending}
        onSubmit={onCreateTeam}
      />

      <UnitsNameDialog
        open={teamToRename !== null}
        onOpenChange={(open) => !open && setTeamToRename(null)}
        title={<Trans>Renomear time</Trans>}
        description={<Trans>O endereço do time continua o mesmo.</Trans>}
        label={<Trans>Nome do time</Trans>}
        initialValue={teamToRename?.name ?? ''}
        maxLength={60}
        submitLabel={<Trans>Salvar</Trans>}
        loading={renameTeam.isPending}
        onSubmit={onRenameTeam}
      />

      <UnitsConfirmDialog
        open={teamToDelete !== null}
        onOpenChange={(open) => !open && setTeamToDelete(null)}
        title={<Trans>Remover o time {teamToDeleteName}?</Trans>}
        description={
          <Trans>
            O time não tem documentos. As pessoas saem dele, mas continuam na unidade, e recebem um e-mail avisando. Não
            dá para desfazer.
          </Trans>
        }
        confirmLabel={<Trans>Remover time</Trans>}
        loading={deleteTeam.isPending}
        onConfirm={onDeleteTeam}
      />

      <MemberTeamsDialog
        open={isAddMemberOpen}
        onOpenChange={setIsAddMemberOpen}
        organisationId={unit.organisationId}
        unitName={unitName}
        teams={teams}
        loading={addMember.isPending}
        onSubmit={onAddMember}
      />

      {memberToEdit && (
        <MemberTeamsDialog
          open
          onOpenChange={(open) => !open && setMemberToEdit(null)}
          organisationId={unit.organisationId}
          unitName={unitName}
          teams={teams}
          person={{ id: memberToEdit.userId, name: memberToEdit.name, email: memberToEdit.email }}
          initialTeams={memberToEdit.teams}
          loading={setMemberTeams.isPending}
          onSubmit={onSetMemberTeams}
        />
      )}

      <UnitsConfirmDialog
        open={memberToRemove !== null}
        onOpenChange={(open) => !open && setMemberToRemove(null)}
        title={
          <Trans>
            Tirar {memberToRemoveName} de {unitName}?
          </Trans>
        }
        description={
          <Trans>
            A pessoa sai da unidade e de todos os times dela. Os documentos que ela enviou ou recebeu para assinar
            continuam com ela.
          </Trans>
        }
        confirmLabel={<Trans>Tirar da unidade</Trans>}
        loading={removeMember.isPending}
        onConfirm={onRemoveMember}
      />
    </div>
  );
}
