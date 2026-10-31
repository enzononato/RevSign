import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import { AppError } from '@documenso/lib/errors/app-error';
import { formatRevalleDateTime } from '@documenso/lib/revalle/date-format';
import {
  CHANGE_REASON_MAX,
  CHANGE_REASON_MIN,
  isValidChangeReason,
} from '@documenso/lib/revalle/finance/account-change';
import { financeStatusLabel, invoiceViewPath } from '@documenso/lib/revalle/finance/finance-status';
import { trpc } from '@documenso/trpc/react';
import type { TGetFinanceCardResponse } from '@documenso/trpc/server/revalle-router/finance/get.types';
import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@documenso/ui/primitives/dialog';
import { Label } from '@documenso/ui/primitives/label';
import { Textarea } from '@documenso/ui/primitives/textarea';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { AccountCombobox } from '../invoice/account-combobox';

type Card = TGetFinanceCardResponse;

/** Erros que não são falha de verdade: a troca criou a nova versão (o envio dela falhou) e o envio em andamento. */
const PARTIAL_SUCCESS = 'FINANCE_NEW_VERSION_NOT_SENT';
const SEND_IN_PROGRESS = 'FINANCE_SEND_IN_PROGRESS';

const formatAccount = (account: { code: string; name: string | null } | null) =>
  account ? `${account.code} – ${account.name ?? ''}` : null;

/** O que o Financeiro pode fazer agora (a mesma regra das rotas do servidor, que conferem de novo). */
const actionsFor = (card: Card) => {
  const sent = card.envelopeStatus === 'PENDING' || card.envelopeStatus === 'COMPLETED';
  const live = !card.rejected && card.envelopeStatus !== 'REJECTED' && card.envelopeStatus !== 'CANCELLED';

  return {
    approve: live && sent && card.financeStatus === 'PENDING_APPROVAL' && card.account !== null,
    change:
      live &&
      ((sent && (card.financeStatus === 'PENDING_APPROVAL' || card.financeStatus === 'APPROVED')) ||
        (card.envelopeStatus === 'COMPLETED' && card.financeStatus === 'LEGACY')),
    define: card.envelopeStatus === 'DRAFT' && card.financeStatus === 'AWAITING_ACCOUNT',
    // Conta já aprovada (troca de conta ou "Definir conta e enviar") e o envio não saiu: manda de novo, mesma conta.
    resend: card.envelopeStatus === 'DRAFT' && card.financeStatus === 'APPROVED' && card.account !== null,
  };
};

export type FinanceCardProps = {
  envelopeId: string;
  /** Depois de uma ação (a página recarrega os dados dela: estado, versões). */
  onChanged?: () => void;
};

/**
 * Cartão "Financeiro" na página da NF, só para quem é do Financeiro: a conta atual, quem escolheu, a sugestão da IA e o
 * estado, com as ações "Aprovar conta", "Trocar conta" (lista + motivo; todos assinam de novo uma nova versão),
 * "Definir conta e enviar" (NF retida) e "Enviar de novo" (conta aprovada cujo envio falhou).
 */
export const FinanceCard = ({ envelopeId, onChanged }: FinanceCardProps) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const reasonId = useId();

  const { data: me } = trpc.revalle.finance.me.useQuery(undefined, DO_NOT_INVALIDATE_QUERY_ON_MUTATION);
  const isFinance = me?.isFinance === true;

  const { data: card, isError } = trpc.revalle.finance.get.useQuery(
    { envelopeId },
    { ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION, enabled: isFinance },
  );

  const actions = card ? actionsFor(card) : null;

  const { data: accountsData } = trpc.revalle.invoice.findAccounts.useQuery(undefined, {
    ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
    enabled: Boolean(actions?.change || actions?.define),
  });

  const approve = trpc.revalle.finance.approve.useMutation();
  const change = trpc.revalle.finance.changeAccount.useMutation();
  const define = trpc.revalle.finance.defineAccount.useMutation();
  const isBusy = approve.isPending || change.isPending || define.isPending;

  const [dialog, setDialog] = useState<'approve' | 'change' | 'change-confirm' | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [definedCode, setDefinedCode] = useState<string | null>(null);

  if (!isFinance) {
    return null;
  }

  if (!card || !actions) {
    return (
      <section
        className="rounded-xl border border-border bg-widget p-4 text-muted-foreground text-sm dark:bg-background"
        data-testid="finance-card"
      >
        {isError ? <Trans>Não foi possível carregar o Financeiro. Tente de novo.</Trans> : <Trans>Carregando…</Trans>}
      </section>
    );
  }

  const refresh = async () => {
    await utils.revalle.finance.get.invalidate({ envelopeId });
    onChanged?.();
  };

  const showError = async (err: unknown) => {
    const error = AppError.parseError(err);
    const message = error.userMessage || error.message;

    if (error.code === PARTIAL_SUCCESS) {
      // A conta foi trocada e a nova versão existe; só o envio dela falhou.
      toast({ title: t`Conta trocada, mas a nova versão não foi enviada`, description: message, duration: 15000 });
      setDialog(null);
      await refresh();

      return;
    }

    if (error.code === SEND_IN_PROGRESS) {
      toast({ title: t`Envio em andamento. Aguarde um instante.`, description: message, duration: 7500 });
      await refresh();

      return;
    }

    toast({ title: t`Não foi possível concluir.`, description: message, variant: 'destructive', duration: 10000 });
  };

  const onApprove = async () => {
    try {
      await approve.mutateAsync({ envelopeId });
      toast({ title: t`Conta aprovada.`, duration: 5000 });
      setDialog(null);
      await refresh();
    } catch (err) {
      setDialog(null);
      await showError(err);
    }
  };

  const onChange = async () => {
    if (!newCode) {
      return;
    }

    try {
      const { newEnvelopeId } = await change.mutateAsync({ envelopeId, code: newCode, reason: reason.trim() });

      toast({
        title: t`Conta trocada. A nova versão foi enviada para todos assinarem de novo.`,
        duration: 7500,
      });
      setDialog(null);
      void navigate(invoiceViewPath(newEnvelopeId));
    } catch (err) {
      setDialog(null);
      await showError(err);
    }
  };

  const onDefine = async (code: string, isResend: boolean) => {
    try {
      const { sent } = await define.mutateAsync({ envelopeId, code });

      toast({
        title: sent
          ? isResend
            ? t`Enviado de novo para assinatura.`
            : t`Conta definida. O documento foi enviado para assinatura.`
          : t`Este documento já tinha sido enviado.`,
        duration: 7500,
      });
      await refresh();
    } catch (err) {
      await showError(err);
    }
  };

  const openChange = () => {
    setNewCode(null);
    setReason('');
    setDialog('change');
  };

  const account = formatAccount(card.account);
  const situation = financeStatusLabel(card.financeStatus, card.envelopeStatus);
  const reasonLength = reason.trim().length;
  const isReasonValid = isValidChangeReason(reason);
  const accounts = (accountsData?.accounts ?? []).filter((option) => option.code !== card.account?.code);
  const chosen = accountsData?.accounts.find((option) => option.code === newCode);
  const definedAccount = accountsData?.accounts.find((option) => option.code === definedCode);

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-border bg-widget p-4 text-foreground text-sm dark:bg-background"
      data-testid="finance-card"
    >
      <h2 className="font-medium text-base">
        <Trans>Financeiro</Trans>
      </h2>

      <dl className="grid grid-cols-1 gap-2">
        <div>
          <dt className="text-muted-foreground">
            <Trans>Situação</Trans>
          </dt>
          <dd className="font-medium" data-testid="finance-card-situation">
            {situation || '-'}
          </dd>
        </div>

        <div>
          <dt className="text-muted-foreground">
            <Trans>Conta contábil</Trans>
          </dt>
          <dd className="break-words" data-testid="finance-card-account">
            {card.deferred ? <Trans>A definir pelo Financeiro</Trans> : (account ?? '-')}
          </dd>
        </div>

        {card.choiceBy && (
          <div>
            <dt className="text-muted-foreground">
              <Trans>Quem escolheu</Trans>
            </dt>
            <dd className="break-words">
              {card.choiceAt ? `${card.choiceBy} · ${formatRevalleDateTime(card.choiceAt)}` : card.choiceBy}
            </dd>
          </div>
        )}

        <div>
          <dt className="text-muted-foreground">
            <Trans>Sugestão da IA</Trans>
          </dt>
          <dd className="break-words">
            {card.suggestion ? (
              <>
                {formatAccount(card.suggestion)}{' '}
                <span className="text-muted-foreground">
                  <Trans>(confiança {card.suggestion.confidence})</Trans>
                </span>
                {card.suggestion.reason && (
                  <span className="block text-muted-foreground">{card.suggestion.reason}</span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">
                <Trans>Sem sugestão</Trans>
              </span>
            )}
          </dd>
        </div>

        {card.approvedBy && card.approvedAt && card.financeStatus !== 'PENDING_APPROVAL' && (
          <div>
            <dt className="text-muted-foreground">
              <Trans>Aprovada por</Trans>
            </dt>
            <dd className="break-words">{`${card.approvedBy} · ${formatRevalleDateTime(card.approvedAt)}`}</dd>
          </div>
        )}

        {card.financeStatus === 'SUPERSEDED' && card.supersedeReason && (
          <div>
            <dt className="text-muted-foreground">
              <Trans>Motivo da troca</Trans>
            </dt>
            <dd className="break-words">{card.supersedeReason}</dd>
          </div>
        )}
      </dl>

      {card.financeStatus === 'SUPERSEDED' && card.supersededByEnvelopeId && (
        <Button asChild variant="outline" className="h-11 w-full whitespace-normal sm:w-auto sm:self-start">
          <Link to={invoiceViewPath(card.supersededByEnvelopeId)}>
            <Trans>Abrir a nova versão</Trans>
          </Link>
        </Button>
      )}

      {actions.define && (
        <div className="flex flex-col gap-2" data-testid="finance-card-define">
          <p className="text-muted-foreground">
            <Trans>
              O remetente deixou a conta para o Financeiro. Escolha a conta: o documento é enviado na hora, com a conta
              já aprovada.
            </Trans>
          </p>
          <AccountCombobox
            accounts={accountsData?.accounts ?? []}
            value={definedCode}
            disabled={isBusy}
            onSelect={setDefinedCode}
          />
          {definedAccount && (
            <p className="break-words">
              <Trans>
                Conta escolhida: {definedAccount.code} – {definedAccount.name}
              </Trans>
            </p>
          )}
          <Button
            type="button"
            className="h-11 w-full whitespace-normal sm:w-auto sm:self-start"
            disabled={!definedCode || isBusy}
            loading={define.isPending}
            onClick={() => definedCode && void onDefine(definedCode, false)}
          >
            <Trans>Definir conta e enviar</Trans>
          </Button>
        </div>
      )}

      {actions.resend && card.account && (
        <div className="flex flex-col gap-2" data-testid="finance-card-resend">
          <p className="text-muted-foreground">
            <Trans>
              A conta já está aprovada, mas o documento ainda não foi enviado. Se o envio falhou, corrija o problema e
              envie de novo (mesma conta).
            </Trans>
          </p>
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full whitespace-normal sm:w-auto sm:self-start"
            disabled={isBusy}
            loading={define.isPending}
            onClick={() => card.account && void onDefine(card.account.code, true)}
          >
            <Trans>Enviar de novo</Trans>
          </Button>
        </div>
      )}

      {(actions.approve || actions.change) && (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {actions.approve && (
            <Button
              type="button"
              className="h-11 w-full whitespace-normal sm:w-auto"
              disabled={isBusy}
              onClick={() => setDialog('approve')}
            >
              <Trans>Aprovar conta</Trans>
            </Button>
          )}
          {actions.change && (
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full whitespace-normal sm:w-auto"
              disabled={isBusy}
              onClick={openChange}
            >
              <Trans>Trocar conta</Trans>
            </Button>
          )}
        </div>
      )}

      <Dialog open={dialog === 'approve'} onOpenChange={(open) => !open && !isBusy && setDialog(null)}>
        <DialogContent position="center" data-testid="finance-approve-dialog">
          <DialogHeader>
            <DialogTitle>
              <Trans>Aprovar a conta?</Trans>
            </DialogTitle>
            <DialogDescription className="break-words">
              <Trans>
                Conta: {account}. Depois de aprovada, a nota fiscal é concluída quando todos tiverem assinado (se todos
                já assinaram, na hora).
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="secondary"
              className="h-11"
              disabled={isBusy}
              onClick={() => setDialog(null)}
            >
              <Trans>Cancelar</Trans>
            </Button>
            <Button type="button" className="h-11" loading={approve.isPending} onClick={() => void onApprove()}>
              <Trans>Aprovar conta</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialog === 'change' || dialog === 'change-confirm'}
        onOpenChange={(open) => !open && !isBusy && setDialog(null)}
      >
        <DialogContent position="center" className="max-h-[90dvh] overflow-y-auto" data-testid="finance-change-dialog">
          {dialog === 'change' ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  <Trans>Trocar conta</Trans>
                </DialogTitle>
                <DialogDescription className="break-words">
                  <Trans>Conta atual: {account ?? '-'}. Escolha a nova conta e escreva o motivo.</Trans>
                </DialogDescription>
              </DialogHeader>

              <div className="flex min-w-0 flex-col gap-2">
                <AccountCombobox accounts={accounts} value={newCode} disabled={isBusy} onSelect={setNewCode} />
                {chosen && (
                  <p className="break-words text-sm">
                    <Trans>
                      Nova conta: {chosen.code} – {chosen.name}
                    </Trans>
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <Label htmlFor={reasonId}>
                  <Trans>Motivo da troca</Trans>
                </Label>
                <Textarea
                  id={reasonId}
                  value={reason}
                  maxLength={CHANGE_REASON_MAX + 50}
                  rows={3}
                  disabled={isBusy}
                  onChange={(event) => setReason(event.target.value)}
                />
                <p
                  className={
                    reasonLength > 0 && !isReasonValid ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'
                  }
                  data-testid="finance-change-counter"
                >
                  <Trans>
                    {reasonLength} de {CHANGE_REASON_MAX} caracteres (mínimo {CHANGE_REASON_MIN})
                  </Trans>
                </p>
              </div>

              <DialogFooter className="gap-2">
                <Button type="button" variant="secondary" className="h-11" onClick={() => setDialog(null)}>
                  <Trans>Cancelar</Trans>
                </Button>
                <Button
                  type="button"
                  className="h-11"
                  disabled={!newCode || !isReasonValid}
                  onClick={() => setDialog('change-confirm')}
                >
                  <Trans>Continuar</Trans>
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  <Trans>Trocar a conta?</Trans>
                </DialogTitle>
                <DialogDescription className="break-words">
                  <Trans>
                    Todos vão assinar de novo uma nova versão. A versão atual deixa de valer, e o remetente e quem
                    assina recebem um aviso com o motivo.
                  </Trans>
                </DialogDescription>
              </DialogHeader>
              {chosen && (
                <p className="break-words text-sm">
                  <Trans>
                    De {account ?? '-'} para {chosen.code} – {chosen.name}.
                  </Trans>
                </p>
              )}
              <DialogFooter className="gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="h-11"
                  disabled={isBusy}
                  onClick={() => setDialog('change')}
                >
                  <Trans>Voltar</Trans>
                </Button>
                <Button type="button" className="h-11" loading={change.isPending} onClick={() => void onChange()}>
                  <Trans>Trocar conta</Trans>
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
};
