import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import { AppError } from '@documenso/lib/errors/app-error';
import { accountingValidationState } from '@documenso/lib/revalle/accounting/accounting-status';
import { formatRevalleDateTime } from '@documenso/lib/revalle/date-format';
import {
  CHANGE_REASON_MAX,
  CHANGE_REASON_MIN,
  isValidChangeReason,
} from '@documenso/lib/revalle/finance/account-change';
import { invoiceViewPath, isNewVersionDraftRow } from '@documenso/lib/revalle/finance/finance-status';
import { costCenterLabel } from '@documenso/lib/revalle/invoice/cost-centers';
import { trpc } from '@documenso/trpc/react';
import type { TGetAccountingCardResponse } from '@documenso/trpc/server/revalle-router/accounting/get.types';
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

import { ConfirmDialog } from '../finance/finance-card';
import { CostCenterSelect } from '../invoice/cost-center-select';

type Card = TGetAccountingCardResponse;

/** A correção criou a nova versão e só o envio dela falhou: não é falha de verdade. */
const PARTIAL_SUCCESS = 'FINANCE_NEW_VERSION_NOT_SENT';

/** O que a Contabilidade pode fazer agora (a mesma regra das rotas do servidor, que conferem de novo). */
const actionsFor = (card: Card) => {
  const sent = card.envelopeStatus === 'PENDING' || card.envelopeStatus === 'COMPLETED';
  const live = sent && !card.rejected;
  const isSuperseded = card.financeStatus === 'SUPERSEDED';
  const hasCenter = card.costCenter !== null;
  const isChangeable =
    card.financeStatus === 'PENDING_APPROVAL' ||
    card.financeStatus === 'APPROVED' ||
    (card.envelopeStatus === 'COMPLETED' && card.financeStatus === 'LEGACY');

  return {
    validate: live && !isSuperseded && hasCenter && card.validatedAt === null,
    // Versão substituída cuja nova versão foi apagada (ou o pedido morreu no meio): corrige de novo.
    change: live && hasCenter && (isChangeable || card.canRetakeChange),
    define: live && !isSuperseded && !hasCenter,
    resend: card.envelopeStatus === 'DRAFT' && isNewVersionDraftRow(card),
  };
};

export type AccountingCardProps = {
  envelopeId: string;
  /** Depois de uma ação (a página recarrega os dados dela: estado, versões). */
  onChanged?: () => void;
};

/**
 * Cartão "Contabilidade" na página da NF, só para quem é da Contabilidade: o centro de custo e a situação da validação,
 * com as ações "Validar centro de custo", "Corrigir centro de custo" (nova versão que todos assinam de novo), "Definir
 * centro de custo" (NF enviada sem centro) e "Enviar de novo" (nova versão cujo envio falhou). Toda ação que grava ou
 * envia pede confirmação.
 */
export const AccountingCard = ({ envelopeId, onChanged }: AccountingCardProps) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const reasonId = useId();

  const { data: me } = trpc.revalle.accounting.me.useQuery(undefined, DO_NOT_INVALIDATE_QUERY_ON_MUTATION);
  const isMember = me?.isMember === true;

  const { data: card, isError } = trpc.revalle.accounting.get.useQuery(
    { envelopeId },
    { ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION, enabled: isMember },
  );

  const validate = trpc.revalle.accounting.validate.useMutation();
  const define = trpc.revalle.accounting.defineCostCenter.useMutation();
  const change = trpc.revalle.accounting.changeCostCenter.useMutation();
  const resend = trpc.revalle.finance.resendVersion.useMutation();
  const isBusy = validate.isPending || define.isPending || change.isPending || resend.isPending;

  const [dialog, setDialog] = useState<'validate' | 'define' | 'change' | 'resend' | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [definedCode, setDefinedCode] = useState<string | null>(null);

  if (!isMember) {
    return null;
  }

  if (!card) {
    return (
      <section
        className="rounded-xl border border-border bg-widget p-4 text-muted-foreground text-sm dark:bg-background"
        data-testid="accounting-card"
      >
        {isError ? (
          <Trans>Não foi possível carregar a Contabilidade. Tente de novo.</Trans>
        ) : (
          <Trans>Carregando…</Trans>
        )}
      </section>
    );
  }

  const actions = actionsFor(card);

  const refresh = async () => {
    await utils.revalle.accounting.get.invalidate({ envelopeId });
    onChanged?.();
  };

  const showError = async (err: unknown) => {
    const error = AppError.parseError(err);
    const message = error.userMessage || error.message;

    if (error.code === PARTIAL_SUCCESS) {
      toast({
        title: t`Centro de custo corrigido, mas a nova versão não foi enviada`,
        description: message,
        duration: 15000,
      });
      setDialog(null);
      await refresh();

      return;
    }

    toast({ title: t`Não foi possível concluir.`, description: message, variant: 'destructive', duration: 10000 });
  };

  const onValidate = async () => {
    try {
      const { validated } = await validate.mutateAsync({ envelopeId });

      toast({
        title: validated ? t`Centro de custo validado.` : t`Este centro de custo já estava validado.`,
        duration: 5000,
      });
      setDialog(null);
      await refresh();
    } catch (err) {
      setDialog(null);
      await showError(err);
    }
  };

  const onDefine = async () => {
    if (!definedCode) {
      return;
    }

    try {
      await define.mutateAsync({ envelopeId, code: definedCode });
      toast({ title: t`Centro de custo definido e validado.`, duration: 5000 });
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
        title: t`Centro de custo corrigido. A nova versão foi enviada para todos assinarem de novo.`,
        duration: 7500,
      });
      setDialog(null);
      void navigate(invoiceViewPath(newEnvelopeId));
    } catch (err) {
      // Falha de verdade: o diálogo continua aberto com o centro e o motivo digitado, para tentar de novo ou cancelar.
      await showError(err);
    }
  };

  const onResend = async () => {
    try {
      const { sent } = await resend.mutateAsync({ envelopeId });

      toast({
        title: sent ? t`Enviado de novo para assinatura.` : t`Este documento já tinha sido enviado.`,
        duration: 7500,
      });
      setDialog(null);
      await refresh();
    } catch (err) {
      setDialog(null);
      await showError(err);
    }
  };

  const openChange = () => {
    setNewCode(null);
    setReason('');
    setDialog('change');
  };

  const center = card.costCenter ? costCenterLabel(card.costCenter.code) : null;
  const chosen = newCode ? costCenterLabel(newCode) : '';
  const defined = definedCode ? costCenterLabel(definedCode) : '';
  const validatedBy = card.validatedBy ?? '';
  const validatedAt = card.validatedAt ? formatRevalleDateTime(card.validatedAt) : '';
  const reasonLength = reason.trim().length;
  const isReasonValid = isValidChangeReason(reason);
  const canChange = newCode !== null && newCode !== card.costCenter?.code && isReasonValid;
  // O cartão nunca abre para NF excluída (404), então `deleted` é sempre falso aqui.
  const validation = accountingValidationState({
    costCenterCode: card.costCenter?.code ?? null,
    costCenterValidatedAt: card.validatedAt,
    status: card.rejected ? 'REJECTED' : card.envelopeStatus,
    financeStatus: card.financeStatus,
    deleted: false,
  });

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-border bg-widget p-4 text-foreground text-sm dark:bg-background"
      data-testid="accounting-card"
    >
      <h2 className="font-medium text-base">
        <Trans>Contabilidade</Trans>
      </h2>

      <dl className="grid grid-cols-1 gap-2">
        <div>
          <dt className="text-muted-foreground">
            <Trans>Centro de custo</Trans>
          </dt>
          <dd className="break-words" data-testid="accounting-card-center">
            {center ?? '-'}
          </dd>
        </div>

        <div>
          <dt className="text-muted-foreground">
            <Trans>Situação</Trans>
          </dt>
          <dd className="break-words font-medium" data-testid="accounting-card-situation">
            {validation === 'NO_COST_CENTER' && <Trans>Sem centro de custo</Trans>}
            {validation === 'NO_VALIDATION' && <Trans>Sem validação</Trans>}
            {validation === 'WAITING' && <Trans>Aguardando validação</Trans>}
            {validation === 'VALIDATED' && (
              <Trans>
                Validado por {validatedBy} em {validatedAt}
              </Trans>
            )}
          </dd>
        </div>

        {card.financeStatus === 'SUPERSEDED' && card.supersedeReason && (
          <div>
            <dt className="text-muted-foreground">
              {card.supersedeKind === 'COST_CENTER' ? (
                <Trans>Motivo da correção</Trans>
              ) : (
                <Trans>Motivo da troca</Trans>
              )}
            </dt>
            <dd className="break-words">{card.supersedeReason}</dd>
          </div>
        )}
      </dl>

      {card.financeStatus === 'SUPERSEDED' && card.canRetakeChange && (
        <p className="text-amber-700 dark:text-amber-400" data-testid="accounting-card-retake">
          <Trans>A nova versão não existe mais: corrija o centro de custo de novo.</Trans>
        </p>
      )}

      {card.financeStatus === 'SUPERSEDED' && card.supersededByEnvelopeId && (
        <Button asChild variant="outline" className="h-11 w-full whitespace-normal sm:w-auto sm:self-start">
          <Link to={invoiceViewPath(card.supersededByEnvelopeId)}>
            <Trans>Abrir a nova versão</Trans>
          </Link>
        </Button>
      )}

      {actions.resend && (
        <div className="flex flex-col gap-2" data-testid="accounting-card-resend">
          <p className="text-muted-foreground">
            <Trans>
              A nova versão ainda não foi enviada. Se o envio falhou, corrija o problema e envie de novo (mesma conta e
              mesmo centro).
            </Trans>
          </p>
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full whitespace-normal sm:w-auto sm:self-start"
            disabled={isBusy}
            loading={resend.isPending}
            onClick={() => setDialog('resend')}
          >
            <Trans>Enviar de novo</Trans>
          </Button>
        </div>
      )}

      {actions.define && (
        <div className="flex flex-col gap-2" data-testid="accounting-card-define">
          <p className="text-muted-foreground">
            <Trans>
              Esta nota fiscal foi enviada sem centro de custo. Escolha o centro: ele fica validado na hora, sem nova
              versão (ninguém viu centro ao assinar).
            </Trans>
          </p>
          <CostCenterSelect value={definedCode} disabled={isBusy} onSelect={setDefinedCode} />
          <Button
            type="button"
            className="h-11 w-full whitespace-normal sm:w-auto sm:self-start"
            disabled={!definedCode || isBusy}
            loading={define.isPending}
            onClick={() => setDialog('define')}
          >
            <Trans>Definir centro de custo</Trans>
          </Button>
        </div>
      )}

      {(actions.validate || actions.change) && (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {actions.validate && (
            <Button
              type="button"
              className="h-11 w-full whitespace-normal sm:w-auto"
              disabled={isBusy}
              onClick={() => setDialog('validate')}
            >
              <Trans>Validar centro de custo</Trans>
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
              <Trans>Corrigir centro de custo</Trans>
            </Button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={dialog === 'validate'}
        isBusy={isBusy}
        isLoading={validate.isPending}
        testId="accounting-validate-dialog"
        title={<Trans>Validar o centro de custo?</Trans>}
        description={
          <Trans>
            Centro de custo: {center}. A validação fica registrada com o seu nome e a data, e não muda o que foi
            assinado.
          </Trans>
        }
        confirmLabel={<Trans>Validar centro de custo</Trans>}
        onCancel={() => setDialog(null)}
        onConfirm={() => void onValidate()}
      />

      <ConfirmDialog
        open={dialog === 'define'}
        isBusy={isBusy}
        isLoading={define.isPending}
        testId="accounting-define-dialog"
        title={<Trans>Definir o centro de custo?</Trans>}
        description={<Trans>Centro de custo: {defined}. Ele fica validado na hora, sem nova versão.</Trans>}
        confirmLabel={<Trans>Definir centro de custo</Trans>}
        onCancel={() => setDialog(null)}
        onConfirm={() => void onDefine()}
      />

      <ConfirmDialog
        open={dialog === 'resend'}
        isBusy={isBusy}
        isLoading={resend.isPending}
        testId="accounting-resend-dialog"
        title={<Trans>Enviar de novo?</Trans>}
        description={
          <Trans>O documento é enviado agora, em nome do remetente, para todos os destinatários assinarem.</Trans>
        }
        confirmLabel={<Trans>Enviar de novo</Trans>}
        onCancel={() => setDialog(null)}
        onConfirm={() => void onResend()}
      />

      <Dialog open={dialog === 'change'} onOpenChange={(open) => !open && !isBusy && setDialog(null)}>
        <DialogContent
          position="center"
          className="max-h-[90dvh] overflow-y-auto"
          data-testid="accounting-change-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Corrigir centro de custo</Trans>
            </DialogTitle>
            <DialogDescription className="break-words">
              <Trans>Centro de custo atual: {center}. Escolha o centro certo e escreva o motivo.</Trans>
            </DialogDescription>
          </DialogHeader>

          <CostCenterSelect value={newCode} disabled={isBusy} onSelect={setNewCode} />

          {newCode === card.costCenter?.code && (
            <p className="text-destructive text-xs">
              <Trans>Escolha um centro de custo diferente do atual.</Trans>
            </p>
          )}

          <div className="flex flex-col gap-1">
            <Label htmlFor={reasonId}>
              <Trans>Motivo da correção</Trans>
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
              data-testid="accounting-change-counter"
            >
              <Trans>
                {reasonLength} de {CHANGE_REASON_MAX} caracteres (mínimo {CHANGE_REASON_MIN})
              </Trans>
            </p>
          </div>

          <p className="font-medium" data-testid="accounting-change-warning">
            <Trans>Todos vão precisar assinar de novo.</Trans>
          </p>

          {canChange && (
            <p className="break-words text-sm">
              <Trans>
                De {center} para {chosen}.
              </Trans>
            </p>
          )}

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
            <Button
              type="button"
              className="h-11"
              disabled={!canChange}
              loading={change.isPending}
              onClick={() => void onChange()}
            >
              <Trans>Corrigir centro de custo</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};
