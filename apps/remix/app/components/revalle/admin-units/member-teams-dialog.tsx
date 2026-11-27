import { trpc } from '@documenso/trpc/react';
import { cn } from '@documenso/ui/lib/utils';
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
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@documenso/ui/primitives/select';
import { Trans, useLingui } from '@lingui/react/macro';
import { CheckIcon, SearchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

export type UnitTeamRole = 'MEMBER' | 'MANAGER';

type Person = { id: number; name: string | null; email: string };

type MemberTeamsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organisationId: string;
  unitName: string;
  teams: { id: number; name: string }[];
  /** Pessoa já na unidade (editar times). Sem ela, o diálogo começa pela busca (adicionar). */
  person?: Person;
  initialTeams?: { teamId: number; role: string }[];
  loading?: boolean;
  /** `role` ausente = mantém o papel atual (administrador do time, dado pelo upstream). */
  onSubmit: (input: { userId: number; teams: { teamId: number; role?: UnitTeamRole }[] }) => void | Promise<void>;
};

const displayName = (person: Person) => person.name?.trim() || person.email;

/** Adicionar pessoa à unidade (busca por nome ou e-mail de quem já tem conta) e escolher os times dela. */
export const MemberTeamsDialog = ({
  open,
  onOpenChange,
  organisationId,
  unitName,
  teams,
  person,
  initialTeams = [],
  loading = false,
  onSubmit,
}: MemberTeamsDialogProps) => {
  const { t } = useLingui();

  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Person | null>(person ?? null);
  // ADMIN só aparece para quem já administra o time: fica marcado, sem troca de papel aqui.
  const [choices, setChoices] = useState<Map<number, UnitTeamRole | 'ADMIN'>>(new Map());

  useEffect(() => {
    if (!open) {
      return;
    }

    setSearchInput('');
    setQuery('');
    setSelected(person ?? null);
    setChoices(
      new Map(
        initialTeams
          .filter((choice) => choice.role === 'MEMBER' || choice.role === 'MANAGER' || choice.role === 'ADMIN')
          .map((choice) => [choice.teamId, choice.role as UnitTeamRole | 'ADMIN']),
      ),
    );
  }, [open]);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput.trim()), 300);

    return () => clearTimeout(timer);
  }, [searchInput]);

  const isAdding = !person;
  const personName = person ? displayName(person) : '';
  const selectedName = selected ? displayName(selected) : '';

  const { data: searchData, isFetching: isSearching } = trpc.revalle.units.searchUsers.useQuery(
    { organisationId, query },
    { enabled: open && isAdding && query.length >= 2 },
  );

  const toggleTeam = (teamId: number, checked: boolean) => {
    setChoices((current) => {
      const next = new Map(current);

      if (checked) {
        next.set(teamId, next.get(teamId) ?? 'MEMBER');
      } else {
        next.delete(teamId);
      }

      return next;
    });
  };

  const setRole = (teamId: number, role: UnitTeamRole) => {
    setChoices((current) => new Map(current).set(teamId, role));
  };

  const canSubmit = selected !== null && !loading;

  const submit = () => {
    if (!selected) {
      return;
    }

    void onSubmit({
      userId: selected.id,
      teams: [...choices].map(([teamId, role]) => (role === 'ADMIN' ? { teamId } : { teamId, role })),
    });
  };

  const results = searchData?.users ?? [];

  return (
    <Dialog open={open} onOpenChange={(next) => !loading && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isAdding ? <Trans>Adicionar pessoa em {unitName}</Trans> : <Trans>Times de {personName}</Trans>}
          </DialogTitle>
          <DialogDescription>
            {isAdding ? (
              <Trans>
                Busque quem já tem conta pelo nome ou e-mail. A pessoa entra na unidade como membro e só vê os times
                marcados.
              </Trans>
            ) : (
              <Trans>Marque os times desta pessoa. Gerente também gerencia o time; membro só envia e assina.</Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        {isAdding && (
          <div className="mt-2 flex flex-col gap-2">
            {selected ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border bg-accent/50 p-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{selectedName}</p>
                  <p className="truncate text-muted-foreground">{selected.email}</p>
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(null)}>
                  <Trans>Trocar</Trans>
                </Button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    autoFocus
                    autoComplete="off"
                    placeholder={t`Nome ou e-mail`}
                    aria-label={t`Buscar pessoa por nome ou e-mail`}
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                  />
                </div>

                {query.length >= 2 && (
                  <ul className="max-h-56 overflow-y-auto rounded-lg border">
                    {isSearching && results.length === 0 && (
                      <li className="p-3 text-muted-foreground text-sm">
                        <Trans>Buscando...</Trans>
                      </li>
                    )}
                    {!isSearching && results.length === 0 && (
                      <li className="p-3 text-muted-foreground text-sm">
                        <Trans>Ninguém com esse nome ou e-mail. A pessoa precisa criar a conta antes.</Trans>
                      </li>
                    )}
                    {results.map((user) => (
                      <li key={user.id} className="border-t first:border-t-0">
                        <button
                          type="button"
                          disabled={user.disabled || user.isMember}
                          className={cn(
                            'flex w-full items-center justify-between gap-3 p-3 text-left text-sm',
                            user.disabled || user.isMember ? 'cursor-not-allowed opacity-60' : 'hover:bg-accent/60',
                          )}
                          onClick={() => setSelected(user)}
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{displayName(user)}</span>
                            <span className="block truncate text-muted-foreground">{user.email}</span>
                          </span>
                          {user.isMember && (
                            <span className="shrink-0 text-muted-foreground text-xs">
                              <Trans>Já está na unidade</Trans>
                            </span>
                          )}
                          {user.disabled && !user.isMember && (
                            <span className="shrink-0 text-muted-foreground text-xs">
                              <Trans>Conta desativada</Trans>
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {query.length < 2 && (
                  <p className="text-muted-foreground text-xs">
                    <Trans>Digite pelo menos 2 letras.</Trans>
                  </p>
                )}
              </>
            )}
          </div>
        )}

        <div className="mt-4">
          <p className="font-semibold text-sm">
            <Trans>Times</Trans>
          </p>

          {teams.length === 0 ? (
            <p className="mt-2 rounded-lg border border-dashed p-3 text-muted-foreground text-sm">
              <Trans>Esta unidade ainda não tem times. A pessoa entra só na unidade; crie os times depois.</Trans>
            </p>
          ) : (
            <ul className="mt-2 max-h-64 overflow-y-auto rounded-lg border">
              {teams.map((team) => {
                const role = choices.get(team.id);
                const checkboxId = `unit-team-${team.id}`;
                const teamName = team.name;

                return (
                  <li key={team.id} className="flex items-center justify-between gap-3 border-t p-3 first:border-t-0">
                    <div className="flex min-w-0 items-center gap-3">
                      <Checkbox
                        id={checkboxId}
                        checked={role !== undefined}
                        onCheckedChange={(checked) => toggleTeam(team.id, checked === true)}
                      />
                      <Label htmlFor={checkboxId} className="truncate font-normal">
                        {team.name}
                      </Label>
                    </div>

                    {role === 'ADMIN' && (
                      <span className="shrink-0 text-muted-foreground text-sm">
                        <Trans>Administrador</Trans>
                      </span>
                    )}

                    {(role === 'MEMBER' || role === 'MANAGER') && (
                      <Select value={role} onValueChange={(value) => setRole(team.id, value as UnitTeamRole)}>
                        <SelectTrigger className="h-9 w-32" aria-label={t`Papel em ${teamName}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="MEMBER">
                            <Trans>Membro</Trans>
                          </SelectItem>
                          <SelectItem value="MANAGER">
                            <Trans>Gerente</Trans>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="mt-6">
          <Button type="button" variant="outline" disabled={loading} onClick={() => onOpenChange(false)}>
            <Trans>Cancelar</Trans>
          </Button>
          <Button type="button" loading={loading} disabled={!canSubmit} onClick={submit}>
            <CheckIcon className="mr-2 h-4 w-4" />
            {isAdding ? <Trans>Adicionar</Trans> : <Trans>Salvar times</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
