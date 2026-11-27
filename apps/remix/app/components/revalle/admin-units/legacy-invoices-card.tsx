import { trpc } from '@documenso/trpc/react';
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
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArchiveRestoreIcon } from 'lucide-react';
import { useState } from 'react';

import { useUnitsErrorToast } from './use-units-error';

/**
 * REVALLE (v.26, Task 7): cartão "Notas antigas do espaço pessoal" da lista de unidades. A prévia só consulta; o botão
 * da confirmação leva as notas para o primeiro time de unidade de quem enviou. Nome e e-mail de quem fica só aqui.
 */
export const LegacyInvoicesCard = () => {
  const { t } = useLingui();
  const { toast } = useToast();
  const showError = useUnitsErrorToast();
  const [isOpen, setIsOpen] = useState(false);

  const { data, isPending, isError, isFetching, refetch } = trpc.revalle.units.legacyInvoices.preview.useQuery();
  const { mutateAsync: move, isPending: isMoving } = trpc.revalle.units.legacyInvoices.move.useMutation();

  const n = data?.moveCount ?? 0;
  const p = data?.movePeopleCount ?? 0;
  const k = data?.stayCount ?? 0;
  const stayPeople = data?.stayPeople ?? [];
  const rest = (data?.stayPeopleCount ?? 0) - stayPeople.length;

  const onOpen = async () => {
    const result = await refetch();

    if (result.isError) {
      showError(result.error, t`Não foi possível carregar. Tente de novo.`);

      return;
    }

    setIsOpen(true);
  };

  const onMove = async () => {
    try {
      const { moved: n, failed } = await move();

      toast({
        title: t`${n} notas levadas para as unidades.`,
        description: failed > 0 ? t`${failed} notas não foram levadas. Tente de novo.` : undefined,
        variant: failed > 0 ? 'destructive' : 'default',
      });
      setIsOpen(false);
    } catch (error) {
      showError(error);
    } finally {
      await refetch();
    }
  };

  if (isPending) {
    return <div className="mt-10 h-24 animate-pulse rounded-lg bg-muted" aria-hidden />;
  }

  if (isError) {
    return (
      <section className="mt-10 rounded-lg border p-4 text-muted-foreground text-sm">
        <Trans>Não foi possível carregar. Tente de novo.</Trans>
      </section>
    );
  }

  if (n === 0 && k === 0) {
    return (
      <p className="mt-10 text-muted-foreground text-sm">
        <Trans>Nenhuma nota antiga no espaço pessoal.</Trans>
      </p>
    );
  }

  return (
    <section className="mt-10 rounded-lg border bg-card p-4" aria-labelledby="units-legacy-invoices-title">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 id="units-legacy-invoices-title" className="font-bold font-display text-xl tracking-[-0.02em]">
            <Trans>Notas antigas do espaço pessoal</Trans>
          </h3>
          <p className="mt-1 max-w-2xl text-muted-foreground text-sm">
            <Trans>
              Notas fiscais enviadas pelo espaço pessoal antes das unidades. O Financeiro e a Contabilidade não veem
              essas notas. Depois de pôr as pessoas nas unidades, leve as notas para o primeiro time da unidade de quem
              enviou.
            </Trans>
          </p>
        </div>

        <Button className="shrink-0" loading={isFetching && !isOpen} onClick={() => void onOpen()}>
          <ArchiveRestoreIcon className="mr-2 h-4 w-4" />
          <Trans>Levar as notas antigas para a unidade de quem enviou</Trans>
        </Button>
      </div>

      <AlertDialog open={isOpen} onOpenChange={(value) => !isMoving && setIsOpen(value)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Levar as notas antigas para a unidade de quem enviou</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                {n} notas de {p} pessoas vão para a unidade de quem enviou. {k} ficam no espaço pessoal porque quem
                enviou não está em nenhuma unidade.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>

          {stayPeople.length > 0 && (
            <div className="text-sm">
              <p className="font-semibold">
                <Trans>Ponha estas pessoas numa unidade e use o botão de novo:</Trans>
              </p>
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                {stayPeople.map((person) => {
                  const count = person.count;

                  return (
                    <li key={person.userId} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate">
                        {person.name?.trim() || person.email}
                        {person.name?.trim() ? <span className="text-muted-foreground"> · {person.email}</span> : null}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        <Trans>{count} notas</Trans>
                      </span>
                    </li>
                  );
                })}
              </ul>
              {rest > 0 && (
                <p className="mt-1 text-muted-foreground">
                  <Trans>e mais {rest} pessoas</Trans>
                </p>
              )}
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isMoving}>
              <Trans>Cancelar</Trans>
            </AlertDialogCancel>
            <Button loading={isMoving} disabled={n === 0} onClick={() => void onMove()}>
              <Trans>Levar {n} notas</Trans>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
};
