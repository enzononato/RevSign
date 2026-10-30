import { trpc } from '@documenso/trpc/react';
import type { TAdminListFinanceUsersResponse } from '@documenso/trpc/server/revalle-router/finance/admin-list-users.types';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import { Input } from '@documenso/ui/primitives/input';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { LandmarkIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

// Igual a FINANCE_USERS_LIMIT (servidor): a lista vem cortada nesse número.
const USERS_LIMIT = 100;

type FinanceUser = TAdminListFinanceUsersResponse['users'][number];

export default function AdminRevalleFinanceiroPage() {
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
  const { mutateAsync: setMember } = trpc.revalle.finance.adminSetMember.useMutation();

  const onToggle = async (user: FinanceUser, member: boolean) => {
    const name = user.name?.trim() || user.email;

    setSavingId(user.id);

    try {
      await setMember({ userId: user.id, member });
      toast({ title: member ? t`${name} agora é do Financeiro.` : t`${name} saiu do Financeiro.` });
      await refetch();
    } catch {
      toast({ title: t`Não foi possível salvar. Tente de novo.`, variant: 'destructive' });
    } finally {
      setSavingId(null);
    }
  };

  const users = data?.users ?? [];

  return (
    <div>
      <div className="flex items-center gap-3">
        <LandmarkIcon className="h-8 w-8" />
        <h2 className="font-semibold text-4xl">
          <Trans>Financeiro</Trans>
        </h2>
      </div>

      <p className="mt-4 max-w-2xl text-muted-foreground text-sm">
        <Trans>
          Quem é do Financeiro vê todas as notas fiscais e aprova a conta contábil de cada uma. Marque quem faz parte; a
          mudança vale na hora.
        </Trans>
      </p>

      <Input
        className="mt-6 max-w-sm"
        placeholder={t`Buscar por nome ou e-mail`}
        aria-label={t`Buscar por nome ou e-mail`}
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
      />

      <div className="mt-4 overflow-x-auto rounded-md border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="p-3">
                <Trans>Nome</Trans>
              </th>
              <th className="p-3">
                <Trans>E-mail</Trans>
              </th>
              <th className="p-3">
                <Trans>Financeiro</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-t">
                <td className="p-3">{user.name?.trim() || '-'}</td>
                <td className="p-3">{user.email}</td>
                <td className="p-3">
                  <Checkbox
                    className="h-5 w-5"
                    checked={user.isFinance}
                    disabled={savingId !== null}
                    aria-label={t`Financeiro: ${user.email}`}
                    onCheckedChange={(checked) => void onToggle(user, checked === true)}
                  />
                </td>
              </tr>
            ))}
            {!isPending && !isError && users.length === 0 && (
              <tr>
                <td colSpan={3} className="p-4 text-center text-muted-foreground">
                  <Trans>Nenhum usuário encontrado.</Trans>
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={3} className="p-4 text-center text-muted-foreground">
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
