import { useSession } from '@documenso/lib/client-only/providers/session';
import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import { invoiceViewPath } from '@documenso/lib/revalle/finance/finance-status';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { DocumentStatus } from '@prisma/client';
import { Link } from 'react-router';

import { AccountCombobox } from './account-combobox';

export type InvoiceAccountCardProps = {
  envelope: { id: string; userId: number; status: DocumentStatus };
};

/**
 * "Conta contábil" na página do documento já enviado (inclusive concluído), só para o dono e o admin.
 * - NF com conta: só leitura (Fase 6: depois do envio, quem troca a conta é o Financeiro), com o estado no Financeiro;
 *   substituída (o Financeiro trocou a conta), com o link para a nova versão.
 * - NF sem conta (marcada depois do envio): a lista já vem aberta, até a primeira escolha.
 * - Enviado (pendente ou concluído) sem resposta a "É nota fiscal?" (UNKNOWN, ex.: NF escaneada enviada pela API): o
 *   cartão com a pergunta e "Marcar como nota fiscal".
 * - Enviado que não é NF (NO, ou enviado antes desta versão): só um link discreto "É uma nota fiscal? Marcar como
 *   nota fiscal", para não pesar na página de todo contrato.
 * Marcar (sem IA) abre em seguida a escolha da conta, no cartão; a NF fica aguardando a aprovação do Financeiro.
 * Num documento concluído, a escolha avisa a contabilidade.
 */
export const InvoiceAccountCard = ({ envelope }: InvoiceAccountCardProps) => {
  const { user } = useSession();
  const { t } = useLingui();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const isOwnerOrAdmin = envelope.status !== DocumentStatus.DRAFT && (user.id === envelope.userId || isAdmin(user));

  const { data: state } = trpc.revalle.invoice.get.useQuery(
    { envelopeId: envelope.id },
    { ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION, enabled: isOwnerOrAdmin },
  );

  const isInvoice = state?.isInvoice === 'YES';
  const canMark = envelope.status === DocumentStatus.PENDING || envelope.status === DocumentStatus.COMPLETED;

  const { data: accountsData } = trpc.revalle.invoice.findAccounts.useQuery(undefined, {
    ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
    enabled: isInvoice && !state?.choice,
  });

  const { mutateAsync: setChoice, isPending: isSavingChoice } = trpc.revalle.invoice.setChoice.useMutation();
  const { mutateAsync: markAsInvoice, isPending: isMarking } = trpc.revalle.invoice.markAsInvoice.useMutation();
  const isPending = isSavingChoice || isMarking;

  if (!isOwnerOrAdmin || !state || (!isInvoice && !canMark)) {
    return null;
  }

  const onMark = async () => {
    try {
      utils.revalle.invoice.get.setData({ envelopeId: envelope.id }, await markAsInvoice({ envelopeId: envelope.id }));
    } catch {
      toast({ title: t`Não foi possível salvar. Tente de novo.`, variant: 'destructive', duration: 5000 });
    }
  };

  if (!isInvoice && state.isInvoice !== 'UNKNOWN') {
    return (
      <div
        className="-my-2 flex flex-wrap items-center gap-x-1 px-1 text-muted-foreground text-sm"
        data-testid="invoice-mark-link"
      >
        <span>
          <Trans>É uma nota fiscal?</Trans>
        </span>
        <Button
          type="button"
          variant="link"
          className="h-11 px-0 text-sm"
          disabled={isPending}
          onClick={() => void onMark()}
        >
          <Trans>Marcar como nota fiscal</Trans>
        </Button>
      </div>
    );
  }

  if (!isInvoice) {
    return (
      <section
        className="flex flex-col gap-2 rounded-xl border border-border bg-widget p-4 text-foreground dark:bg-background"
        data-testid="invoice-account-card"
      >
        <h2 className="font-medium">
          <Trans>Conta contábil</Trans>
        </h2>

        <p className="font-medium text-sm">
          <Trans>Este documento é uma nota fiscal?</Trans>
        </p>

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

  const onChoose = async (code: string) => {
    try {
      utils.revalle.invoice.get.setData(
        { envelopeId: envelope.id },
        await setChoice({ envelopeId: envelope.id, choice: { code } }),
      );
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
      <h2 className="font-medium">
        <Trans>Conta contábil</Trans>
      </h2>

      <p className="break-words text-sm">
        {!state.choice ? (
          <Trans>Nenhuma conta escolhida.</Trans>
        ) : choiceCode === 'DEFER' ? (
          <Trans>A definir pelo Financeiro.</Trans>
        ) : (
          `${choiceCode} · ${choiceName}`
        )}
      </p>

      {state.financeStatus === 'AWAITING_ACCOUNT' && (
        <p className="text-muted-foreground text-sm">
          <Trans>Aguardando o Financeiro definir a conta</Trans>
        </p>
      )}

      {state.financeStatus === 'PENDING_APPROVAL' && state.choice && (
        <p className="text-muted-foreground text-sm">
          <Trans>Aguardando aprovação do Financeiro</Trans>
        </p>
      )}

      {state.financeStatus === 'APPROVED' && (
        <p className="text-muted-foreground text-sm">
          <Trans>Aprovada pelo Financeiro</Trans>
        </p>
      )}

      {state.financeStatus === 'SUPERSEDED' && (
        <>
          <p className="text-muted-foreground text-sm" data-testid="invoice-account-superseded">
            <Trans>Substituída: o Financeiro trocou a conta e criou uma nova versão, que todos assinam de novo.</Trans>
          </p>
          {state.supersededByEnvelopeId && (
            <Button asChild variant="outline" className="h-11 w-full whitespace-normal sm:w-auto sm:self-start">
              <Link to={invoiceViewPath(state.supersededByEnvelopeId)}>
                <Trans>Abrir a nova versão</Trans>
              </Link>
            </Button>
          )}
        </>
      )}

      {!state.choice && (
        <>
          <AccountCombobox
            accounts={accountsData?.accounts ?? []}
            value={null}
            disabled={isPending}
            onSelect={(code) => void onChoose(code)}
          />

          <p className="text-amber-700 text-sm dark:text-amber-400">
            <Trans>Escolha a conta contábil. Depois, quem aprova ou troca é o Financeiro.</Trans>
          </p>
        </>
      )}
    </section>
  );
};
