import { trpc } from '@documenso/trpc/react';
import { Alert, AlertDescription, AlertTitle } from '@documenso/ui/primitives/alert';
import { Button } from '@documenso/ui/primitives/button';
import { Switch } from '@documenso/ui/primitives/switch';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { Link, useRevalidator, useSearchParams } from 'react-router';

/**
 * REVALLE (v.26): inativação pela folha na tela "Usuários" do painel. Filtro "Inativados pela folha", botão "Reativar"
 * (reativa e liga "Mantido ativo pelo TI") e a marca "Mantido ativo pelo TI" na página do usuário.
 */

export const HrInactivatedFilter = ({ active }: { active: boolean }) => {
  const [searchParams] = useSearchParams();
  const next = new URLSearchParams(searchParams);

  if (active) {
    next.delete('folha');
  } else {
    next.set('folha', '1');
  }

  next.set('page', '1');

  return (
    <div className="flex items-center gap-2">
      <Button variant={active ? 'default' : 'outline'} size="sm" asChild>
        <Link to={`?${next.toString()}`} aria-pressed={active} data-testid="revalle-hr-inactivated-filter">
          <Trans>Inativados pela folha</Trans>
        </Link>
      </Button>
    </div>
  );
};

export const ReactivateUserButton = ({ userId, onDone }: { userId: number; onDone?: () => Promise<unknown> }) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const { revalidate } = useRevalidator();

  const { mutateAsync: reactivate, isPending } = trpc.admin.user.revalle.reactivate.useMutation();

  const onClick = async () => {
    try {
      await reactivate({ userId });
      toast({ title: t`Conta reativada. Ela fica marcada como "Mantido ativo pelo TI".` });
      await (onDone ? onDone() : revalidate());
    } catch {
      toast({ title: t`Não foi possível reativar. Tente de novo.`, variant: 'destructive' });
    }
  };

  return (
    <Button size="sm" loading={isPending} onClick={onClick}>
      <Trans>Reativar</Trans>
    </Button>
  );
};

export const RevalleUserStatusPanel = ({ userId }: { userId: number }) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const { data, refetch } = trpc.admin.user.revalle.status.useQuery({ userId });
  const { mutateAsync: setKeepActive, isPending } = trpc.admin.user.revalle.setKeepActive.useMutation();

  if (!data) {
    return null;
  }

  const onToggle = async (keepActive: boolean) => {
    try {
      await setKeepActive({ userId, keepActive });
      await refetch();
    } catch {
      toast({ title: t`Não foi possível salvar. Tente de novo.`, variant: 'destructive' });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {data.hrInactivated && (
        <Alert className="flex flex-col items-center justify-between gap-4 p-6 md:flex-row" variant="warning">
          <div>
            <AlertTitle>
              <Trans>Inativado pela folha</Trans>
            </AlertTitle>
            <AlertDescription className="mr-2">
              <Trans>
                A base do RH mostra esta pessoa como desligada e a rotina da noite desativou a conta. Reativar libera a
                conta e marca "Mantido ativo pelo TI".
              </Trans>
            </AlertDescription>
          </div>
          <div className="flex-shrink-0">
            <ReactivateUserButton
              userId={userId}
              onDone={async () => {
                await refetch();
                // A página do usuário lê a conta pelo tRPC do upstream: atualiza para trocar "Ativar" por "Desativar".
                await utils.admin.user.get.invalidate({ id: userId });
              }}
            />
          </div>
        </Alert>
      )}

      <Alert className="flex flex-col items-center justify-between gap-4 p-6 md:flex-row" variant="neutral">
        <div>
          <AlertTitle>
            <Trans>Mantido ativo pelo TI</Trans>
          </AlertTitle>
          <AlertDescription className="mr-2">
            <Trans>
              Com a marca ligada, a rotina da noite não desativa esta conta, mesmo que a folha mostre desligado.
            </Trans>
          </AlertDescription>
        </div>
        <div className="flex-shrink-0">
          <Switch
            checked={data.keepActive}
            disabled={isPending}
            onCheckedChange={onToggle}
            aria-label={t`Mantido ativo pelo TI`}
          />
        </div>
      </Alert>
    </div>
  );
};
