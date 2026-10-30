import { useSession } from '@documenso/lib/client-only/providers/session';
import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { DocumentStatus } from '@prisma/client';
import { useState } from 'react';

import { AccountCombobox } from './account-combobox';

export type InvoiceAccountCardProps = {
  envelope: { id: string; userId: number; status: DocumentStatus };
};

/**
 * "Conta contábil" na página do documento já enviado (inclusive concluído), só para NF e só para o dono e o admin,
 * que podem trocar a conta (cada troca vai para o histórico do documento).
 */
export const InvoiceAccountCard = ({ envelope }: InvoiceAccountCardProps) => {
  const { user } = useSession();
  const { t } = useLingui();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const [isChanging, setIsChanging] = useState(false);

  const canChange = envelope.status !== DocumentStatus.DRAFT && (user.id === envelope.userId || isAdmin(user));

  const { data: state } = trpc.revalle.invoice.get.useQuery(
    { envelopeId: envelope.id },
    { ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION, enabled: canChange },
  );

  const isInvoice = state?.isInvoice === 'YES';

  const { data: accountsData } = trpc.revalle.invoice.findAccounts.useQuery(undefined, {
    ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
    enabled: isInvoice && isChanging,
  });

  const { mutateAsync: setChoice, isPending } = trpc.revalle.invoice.setChoice.useMutation();

  if (!canChange || !state || !isInvoice) {
    return null;
  }

  const onChoose = async (choice: { code: string } | { defer: true }) => {
    try {
      utils.revalle.invoice.get.setData(
        { envelopeId: envelope.id },
        await setChoice({ envelopeId: envelope.id, choice }),
      );
      setIsChanging(false);
      toast({ title: t`Conta contábil atualizada.`, duration: 5000 });
    } catch {
      toast({ title: t`Não foi possível salvar. Tente de novo.`, variant: 'destructive', duration: 5000 });
    }
  };

  const choiceCode = state.choice?.code;
  const choiceName = state.choice?.name ?? '';

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-border bg-widget p-4 text-foreground dark:bg-background"
      data-testid="invoice-account-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <h2 className="font-medium">
          <Trans>Conta contábil</Trans>
        </h2>

        {!isChanging && (
          <Button type="button" variant="link" className="h-11 px-0" onClick={() => setIsChanging(true)}>
            <Trans>Trocar</Trans>
          </Button>
        )}
      </div>

      <p className="break-words text-sm">
        {!state.choice ? (
          <Trans>Nenhuma conta escolhida.</Trans>
        ) : choiceCode === 'DEFER' ? (
          <Trans>A definir pela contabilidade.</Trans>
        ) : (
          `${choiceCode} · ${choiceName}`
        )}
      </p>

      {isChanging && (
        <>
          <AccountCombobox
            accounts={accountsData?.accounts ?? []}
            value={choiceCode ?? null}
            disabled={isPending}
            onSelect={(code) => void onChoose({ code })}
          />

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              className="h-11 flex-1 whitespace-normal"
              disabled={isPending}
              onClick={() => void onChoose({ defer: true })}
            >
              <Trans>Deixar para a contabilidade decidir</Trans>
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="h-11"
              disabled={isPending}
              onClick={() => setIsChanging(false)}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </>
      )}
    </section>
  );
};
