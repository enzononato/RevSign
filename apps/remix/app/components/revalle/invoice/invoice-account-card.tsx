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
 * "Conta contábil" na página do documento já enviado (inclusive concluído), só para o dono e o admin.
 * - NF: mostra a conta e deixa trocar (cada troca vai para o histórico do documento). NF sem conta: a lista já vem
 *   aberta, sem "Cancelar", até a escolha.
 * - Enviado (pendente ou concluído) que não ficou como NF (ex.: NF escaneada enviada sem resposta): "Marcar como nota
 *   fiscal" (sem IA) e, em seguida, a escolha da conta. Num documento concluído, a escolha avisa a contabilidade.
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
  const canMark = envelope.status === DocumentStatus.PENDING || envelope.status === DocumentStatus.COMPLETED;

  const { data: accountsData } = trpc.revalle.invoice.findAccounts.useQuery(undefined, {
    ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
    enabled: isInvoice && (isChanging || !state?.choice),
  });

  const { mutateAsync: setChoice, isPending: isSavingChoice } = trpc.revalle.invoice.setChoice.useMutation();
  const { mutateAsync: markAsInvoice, isPending: isMarking } = trpc.revalle.invoice.markAsInvoice.useMutation();
  const isPending = isSavingChoice || isMarking;

  if (!canChange || !state || (!isInvoice && !canMark)) {
    return null;
  }

  const onMark = async () => {
    try {
      utils.revalle.invoice.get.setData({ envelopeId: envelope.id }, await markAsInvoice({ envelopeId: envelope.id }));
      setIsChanging(true);
    } catch {
      toast({ title: t`Não foi possível salvar. Tente de novo.`, variant: 'destructive', duration: 5000 });
    }
  };

  if (!isInvoice) {
    return (
      <section
        className="flex flex-col gap-2 rounded-xl border border-border bg-widget p-4 text-foreground dark:bg-background"
        data-testid="invoice-account-card"
      >
        <h2 className="font-medium">
          <Trans>Conta contábil</Trans>
        </h2>

        <p className="text-muted-foreground text-sm">
          <Trans>Se este documento for uma nota fiscal, marque aqui para escolher a conta contábil.</Trans>
        </p>

        <Button
          type="button"
          variant="outline"
          className="h-11 w-full whitespace-normal sm:w-auto sm:self-start"
          disabled={isPending}
          onClick={() => void onMark()}
        >
          <Trans>Marcar como nota fiscal</Trans>
        </Button>
      </section>
    );
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
  // NF sem conta (acabou de ser marcada, ou enviada sem escolha): a escolha é pedida já, sem "Cancelar".
  const isChoosing = isChanging || !state.choice;

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-border bg-widget p-4 text-foreground dark:bg-background"
      data-testid="invoice-account-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <h2 className="font-medium">
          <Trans>Conta contábil</Trans>
        </h2>

        {!isChoosing && (
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

      {isChoosing && (
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
              className="h-11 whitespace-normal sm:flex-1"
              disabled={isPending}
              onClick={() => void onChoose({ defer: true })}
            >
              <Trans>Deixar para a contabilidade decidir</Trans>
            </Button>
            {state.choice && (
              <Button
                type="button"
                variant="secondary"
                className="h-11"
                disabled={isPending}
                onClick={() => setIsChanging(false)}
              >
                <Trans>Cancel</Trans>
              </Button>
            )}
          </div>

          {!state.choice && (
            <p className="text-amber-700 text-sm dark:text-amber-400">
              <Trans>Escolha a conta contábil ou deixe para a contabilidade decidir.</Trans>
            </p>
          )}
        </>
      )}
    </section>
  );
};
