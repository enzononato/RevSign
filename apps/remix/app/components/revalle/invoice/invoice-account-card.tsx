import { useSession } from '@documenso/lib/client-only/providers/session';
import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import { invoiceViewPath } from '@documenso/lib/revalle/finance/finance-status';
import { costCenterLabel } from '@documenso/lib/revalle/invoice/cost-centers';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { DocumentStatus } from '@prisma/client';
import { Link } from 'react-router';

import { AccountCombobox } from './account-combobox';
import { CostCenterSelect } from './cost-center-select';
import { InvoiceDuplicateNotice } from './invoice-duplicate-notice';
import { InvoiceCard, InvoiceCode, InvoiceRow, InvoiceRows, InvoiceStatePill, splitCodeLabel } from './invoice-ui';

export type InvoiceAccountCardProps = {
  envelope: { id: string; userId: number; status: DocumentStatus };
};

/**
 * "Conta contábil" na página do documento já enviado (inclusive concluído), só para o dono e o admin.
 * - NF com conta: só leitura (Fase 6: depois do envio, quem troca a conta é o Financeiro), com o estado no Financeiro;
 *   substituída (o Financeiro trocou a conta ou a Contabilidade corrigiu o centro), com o link para a nova versão.
 * - NF sem conta (marcada depois do envio): a lista já vem aberta, até a primeira escolha.
 * - Centro de custo (Fase 7): em leitura quando já escolhido (depois do envio quem corrige é a Contabilidade); sem
 *   centro (NF marcada depois do envio, ou enviada antes desta versão), o dono e o admin escolhem o primeiro aqui, sem
 *   nova versão.
 * - Enviado (pendente ou concluído) sem resposta a "É nota fiscal?" (UNKNOWN, ex.: NF escaneada enviada pela API): o
 *   cartão com a pergunta e "Marcar como nota fiscal".
 * - Enviado que não é NF (NO, ou enviado antes desta versão): só um link discreto "É uma nota fiscal? Marcar como
 *   nota fiscal", para não pesar na página de todo contrato.
 * Marcar (sem IA) abre em seguida a escolha da conta, no cartão; a NF fica aguardando a aprovação do Financeiro.
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
  const { mutateAsync: setCostCenter, isPending: isSavingCostCenter } =
    trpc.revalle.invoice.setCostCenter.useMutation();
  const { mutateAsync: markAsInvoice, isPending: isMarking } = trpc.revalle.invoice.markAsInvoice.useMutation();
  const isPending = isSavingChoice || isSavingCostCenter || isMarking;

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
        className="flex flex-wrap items-center gap-x-1 px-1 text-muted-foreground text-sm"
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
      // REVALLE v3: cartão macio
      <InvoiceCard title={<Trans>Conta contábil</Trans>} testId="invoice-account-card">
        <p className="font-semibold">
          <Trans>Este documento é uma nota fiscal?</Trans>
        </p>

        <p className="text-muted-foreground">
          <Trans>Se este documento for uma nota fiscal, marque aqui para escolher a conta contábil.</Trans>
        </p>

        <Button
          type="button"
          variant="outline"
          className="w-full whitespace-normal"
          disabled={isPending}
          onClick={() => void onMark()}
        >
          <Trans>Marcar como nota fiscal</Trans>
        </Button>
      </InvoiceCard>
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

  const onChooseCostCenter = async (code: string) => {
    try {
      utils.revalle.invoice.get.setData(
        { envelopeId: envelope.id },
        await setCostCenter({ envelopeId: envelope.id, code }),
      );
      toast({ title: t`Centro de custo atualizado.`, duration: 5000 });
    } catch {
      toast({ title: t`Não foi possível salvar. Tente de novo.`, variant: 'destructive', duration: 5000 });
    }
  };

  const choiceCode = state.choice?.code;
  const choiceName = state.choice?.name ?? '';
  // A versão substituída não recebe conta nem centro: a nova versão é a que vale.
  const canChooseCostCenter = !state.costCenter && state.financeStatus !== 'SUPERSEDED';

  // REVALLE v3: cartão macio no padrão "rótulo à esquerda, valor à direita", código em azul, situação em pílula.
  return (
    <InvoiceCard title={<Trans>Nota fiscal</Trans>} testId="invoice-account-card">
      <InvoiceRows>
        <InvoiceRow label={<Trans>Conta contábil</Trans>}>
          {state.choice && choiceCode ? (
            <InvoiceCode code={choiceCode} name={choiceName} />
          ) : (
            <span className="font-normal text-muted-foreground">
              <Trans>Nenhuma conta escolhida.</Trans>
            </span>
          )}
        </InvoiceRow>

        {state.costCenter && (
          <InvoiceRow label={<Trans>Centro de custo</Trans>} testId="invoice-cost-center-value">
            <InvoiceCode {...splitCodeLabel(costCenterLabel(state.costCenter.code))} />
          </InvoiceRow>
        )}

        {((state.financeStatus === 'PENDING_APPROVAL' && state.choice) || state.financeStatus === 'APPROVED') && (
          <InvoiceRow label={<Trans>Financeiro</Trans>} stacked>
            {state.financeStatus === 'APPROVED' ? (
              <InvoiceStatePill tone="success">
                <Trans>Aprovada pelo Financeiro</Trans>
              </InvoiceStatePill>
            ) : (
              <InvoiceStatePill tone="warning">
                <Trans>Aguardando aprovação do Financeiro</Trans>
              </InvoiceStatePill>
            )}
          </InvoiceRow>
        )}
      </InvoiceRows>

      {/* REVALLE (Fase 8): depois do envio o aviso é só informação, sem a confirmação do diálogo de envio. */}
      <InvoiceDuplicateNotice duplicates={state.duplicates} />

      {state.financeStatus === 'SUPERSEDED' && (
        <>
          <p className="text-muted-foreground" data-testid="invoice-account-superseded">
            {state.supersedeKind === 'COST_CENTER' ? (
              <Trans>
                Substituída: a Contabilidade corrigiu o centro de custo e criou uma nova versão, que todos assinam de
                novo.
              </Trans>
            ) : (
              <Trans>
                Substituída: o Financeiro trocou a conta e criou uma nova versão, que todos assinam de novo.
              </Trans>
            )}
          </p>
          {state.supersededByEnvelopeId && (
            <Button asChild variant="outline" className="w-full whitespace-normal">
              <Link to={invoiceViewPath(state.supersededByEnvelopeId)}>
                <Trans>Abrir a nova versão</Trans>
              </Link>
            </Button>
          )}
        </>
      )}

      {!state.choice && state.financeStatus !== 'SUPERSEDED' && (
        <>
          <AccountCombobox
            accounts={accountsData?.accounts ?? []}
            value={null}
            disabled={isPending}
            onSelect={(code) => void onChoose(code)}
          />

          <p className="text-warning-text">
            <Trans>Escolha a conta contábil. Depois, quem aprova ou troca é o Financeiro.</Trans>
          </p>
        </>
      )}

      {canChooseCostCenter && (
        <>
          <CostCenterSelect value={null} disabled={isPending} onSelect={(code) => void onChooseCostCenter(code)} />

          <p className="text-warning-text">
            <Trans>Escolha o centro de custo. Depois, quem corrige é a Contabilidade.</Trans>
          </p>
        </>
      )}
    </InvoiceCard>
  );
};
