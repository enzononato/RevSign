import { trpc } from '@documenso/trpc/react';
import type { TAdminListFinanceUsersResponse } from '@documenso/trpc/server/revalle-router/finance/admin-list-users.types';
import { Input } from '@documenso/ui/primitives/input';
import { Switch } from '@documenso/ui/primitives/switch';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

// Igual a PROFILE_USERS_LIMIT (servidor): a lista vem cortada nesse número.
const USERS_LIMIT = 100;

type ProfileUser = TAdminListFinanceUsersResponse['users'][number];
type Profile = 'finance' | 'accounting';

export default function AdminRevallePerfisPage() {
  const { t } = useLingui();
  const { toast } = useToast();

  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [savingId, setSavingId] = useState<number | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput.trim()), 400);

    return () => clearTimeout(timer);
  }, [searchInput]);

  const { data, isPending, isError, refetch } = trpc.revalle.finance.adminListUsers.useQuery({
    query: query || undefined,
  });
  const { mutateAsync: setFinanceMember } = trpc.revalle.finance.adminSetMember.useMutation();
  const { mutateAsync: setAccountingMember } = trpc.revalle.accounting.adminSetMember.useMutation();

  const onToggle = async (user: ProfileUser, profile: Profile, checked: boolean) => {
    const name = user.name?.trim() || user.email;

    setSavingId(user.id);

    try {
      if (profile === 'finance') {
        await setFinanceMember({ userId: user.id, member: checked });
        toast({ title: checked ? t`${name} agora é do Financeiro.` : t`${name} saiu do Financeiro.` });
      } else {
        await setAccountingMember({ userId: user.id, isMember: checked });
        toast({ title: checked ? t`${name} agora é da Contabilidade.` : t`${name} saiu da Contabilidade.` });
      }

      await refetch();
    } catch {
      toast({ title: t`Não foi possível salvar. Tente de novo.`, variant: 'destructive' });
    } finally {
      setSavingId(null);
    }
  };

  const users = data?.users ?? [];
  const approvalCount = data?.awaitingApprovalCount ?? 0;
  const accountingPendingCount = data?.accountingPendingCount ?? 0;
  const hasNoFinanceMembers = data?.memberCount === 0;
  const hasNoAccountingMembers = data?.accountingMemberCount === 0;

  return (
    <div>
      <h2 className="font-black font-display text-[26px] leading-tight tracking-[-0.03em]">
        <Trans>Perfis</Trans>
      </h2>

      <p className="mt-4 max-w-2xl text-muted-foreground text-sm">
        <Trans>
          Toda conta é de colaborador: envia e assina. Marque quem também é do Financeiro (aprova a conta contábil de
          cada nota fiscal) ou da Contabilidade (valida e corrige o centro de custo). Os dois perfis veem todas as notas
          fiscais, e a mesma pessoa pode ter os dois. A mudança vale na hora.
        </Trans>
      </p>

      {hasNoFinanceMembers && approvalCount > 0 && (
        <div
          role="alert"
          className="mt-4 flex max-w-2xl flex-col gap-1 rounded-lg border border-warning/40 bg-warning-bg p-4 text-sm text-warning-text"
          data-testid="finance-admin-alert"
        >
          <p>
            <Trans>
              Notas fiscais assinadas aguardando a aprovação do Financeiro: {approvalCount}. Ninguém está marcado como
              Financeiro: marque alguém abaixo. As notas esperam na página Notas fiscais até alguém do Financeiro
              aprovar.
            </Trans>
          </p>
        </div>
      )}

      {hasNoAccountingMembers && accountingPendingCount > 0 && (
        <div
          role="alert"
          className="mt-4 flex max-w-2xl flex-col gap-1 rounded-lg border border-warning/40 bg-warning-bg p-4 text-sm text-warning-text"
          data-testid="accounting-admin-alert"
        >
          <p>
            <Trans>
              Notas fiscais com o centro de custo aguardando a Contabilidade: {accountingPendingCount}. Ninguém está
              marcado como Contabilidade: marque alguém abaixo para validar ou corrigir os centros. As notas seguem o
              fluxo normal enquanto isso.
            </Trans>
          </p>
        </div>
      )}

      <Input
        className="mt-6 max-w-sm"
        placeholder={t`Buscar por nome ou e-mail`}
        aria-label={t`Buscar por nome ou e-mail`}
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
      />

      <div className="mt-4 overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/60 font-semibold text-muted-foreground text-xs uppercase tracking-[0.04em]">
            <tr>
              <th className="p-3 font-semibold">
                <Trans>Nome</Trans>
              </th>
              <th className="p-3 font-semibold">
                <Trans>E-mail</Trans>
              </th>
              <th className="p-3 font-semibold">
                <Trans>Financeiro</Trans>
              </th>
              <th className="p-3 font-semibold">
                <Trans>Contabilidade</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-t hover:bg-accent/60">
                <td className="p-3">{user.name?.trim() || '-'}</td>
                <td className="p-3">{user.email}</td>
                <td className="p-3">
                  <Switch
                    checked={user.isFinanceMember}
                    disabled={savingId !== null}
                    aria-label={t`Financeiro: ${user.email}`}
                    onCheckedChange={(checked) => void onToggle(user, 'finance', checked)}
                  />
                </td>
                <td className="p-3">
                  <Switch
                    checked={user.isAccountingMember}
                    disabled={savingId !== null}
                    aria-label={t`Contabilidade: ${user.email}`}
                    onCheckedChange={(checked) => void onToggle(user, 'accounting', checked)}
                  />
                </td>
              </tr>
            ))}
            {!isPending && !isError && users.length === 0 && (
              <tr>
                <td colSpan={4} className="p-4 text-center text-muted-foreground">
                  <Trans>Nenhum usuário encontrado.</Trans>
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={4} className="p-4 text-center text-muted-foreground">
                  <Trans>Não foi possível carregar os usuários. Tente de novo.</Trans>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {users.length >= USERS_LIMIT && (
        <p className="mt-2 text-muted-foreground text-sm">
          <Trans>Mostrando os primeiros {USERS_LIMIT}. Use a busca para achar os outros.</Trans>
        </p>
      )}
    </div>
  );
}
