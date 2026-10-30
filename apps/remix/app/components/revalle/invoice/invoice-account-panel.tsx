import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { trpc } from '@documenso/trpc/react';
import type { TInvoiceState } from '@documenso/trpc/server/revalle-router/invoice/invoice-state.types';
import { Button } from '@documenso/ui/primitives/button';
import { Spinner } from '@documenso/ui/primitives/spinner';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';

import { AccountCombobox } from './account-combobox';

export type InvoiceAccountPanelProps = {
  envelopeId: string;
  /** `false` enquanto a NF não tem escolha (ou o estado ainda não chegou): o botão de enviar fica bloqueado. */
  onReadyChange: (ready: boolean) => void;
};

const POLL_INTERVAL_MS = 2_000;
// Depois disso a tela desiste de esperar (o servidor desiste em 20 s; aqui sobra margem para o job começar).
const POLL_LIMIT_MS = 30_000;

/**
 * Bloco "Nota fiscal · Conta contábil" do diálogo de envio. Classifica ao abrir, consulta a sugestão enquanto ela
 * está em andamento e grava cada escolha no servidor na hora (o envio confere de novo). A sugestão nunca vira
 * escolha sozinha.
 */
export const InvoiceAccountPanel = ({ envelopeId, onReadyChange }: InvoiceAccountPanelProps) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const [isClassified, setIsClassified] = useState(false);
  const [hasGivenUp, setHasGivenUp] = useState(false);
  const [isChanging, setIsChanging] = useState(false);
  const pendingSince = useRef<number | null>(null);

  const { mutateAsync: classify } = trpc.revalle.invoice.classify.useMutation();
  const { mutateAsync: setChoice, isPending: isSavingChoice } = trpc.revalle.invoice.setChoice.useMutation();
  const { mutateAsync: setInvoiceFlag, isPending: isSavingFlag } = trpc.revalle.invoice.setInvoiceFlag.useMutation();
  const { mutateAsync: resuggest, isPending: isResuggesting } = trpc.revalle.invoice.resuggest.useMutation();

  const store = (state: TInvoiceState) => utils.revalle.invoice.get.setData({ envelopeId }, state);

  useEffect(() => {
    // Os arquivos podem ter mudado no editor: classifica (só refaz a detecção se mudaram).
    classify({ envelopeId })
      .then(store)
      .catch(() => undefined)
      .finally(() => setIsClassified(true));
  }, [envelopeId]);

  const { data: state, isError } = trpc.revalle.invoice.get.useQuery(
    { envelopeId },
    {
      ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
      enabled: isClassified,
      refetchInterval: (query) =>
        query.state.data?.suggestionStatus === 'PENDING' && !hasGivenUp ? POLL_INTERVAL_MS : false,
    },
  );

  const isPending = state?.suggestionStatus === 'PENDING';

  useEffect(() => {
    if (!isPending) {
      pendingSince.current = null;
      setHasGivenUp(false);

      return;
    }

    pendingSince.current = pendingSince.current ?? Date.now();

    const timer = setTimeout(() => setHasGivenUp(true), POLL_LIMIT_MS - (Date.now() - pendingSince.current));

    return () => clearTimeout(timer);
  }, [isPending]);

  const isInvoice = state?.isInvoice === 'YES';

  const { data: accountsData } = trpc.revalle.invoice.findAccounts.useQuery(undefined, {
    ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
    enabled: isInvoice,
  });

  // Sem estado (erro na consulta), o envio segue: o servidor confere de qualquer forma.
  const isReady = isError || (state !== undefined && (!isInvoice || state.choice !== null));

  useEffect(() => {
    onReadyChange(isReady);
  }, [isReady]);

  const showError = () =>
    toast({ title: t`Não foi possível salvar. Tente de novo.`, variant: 'destructive', duration: 5000 });

  const onChoose = async (choice: { code: string } | { defer: true }) => {
    try {
      store(await setChoice({ envelopeId, choice }));
      setIsChanging(false);
    } catch {
      showError();
    }
  };

  const onFlag = async (value: boolean) => {
    try {
      store(await setInvoiceFlag({ envelopeId, isInvoice: value }));
    } catch {
      showError();
    }
  };

  const onResuggest = async () => {
    try {
      store(await resuggest({ envelopeId }));
    } catch (err) {
      const error = AppError.parseError(err);

      toast({
        title:
          error.code === AppErrorCode.TOO_MANY_REQUESTS
            ? t`Limite de sugestões atingido. Escolha na lista.`
            : t`Não foi possível sugerir; escolha na lista`,
        variant: 'destructive',
        duration: 5000,
      });
    }
  };

  if (!state) {
    if (isError) {
      return null;
    }

    return (
      <p className="mb-4 flex items-center gap-2 text-muted-foreground text-sm">
        <Spinner size="sm" />
        <Trans>Conferindo se é nota fiscal…</Trans>
      </p>
    );
  }

  const isBusy = isSavingChoice || isSavingFlag || isResuggesting;

  if (state.isInvoice === 'NO') {
    // Só quem marcou "Não é nota fiscal" vê o desfazer; documento comum não muda em nada.
    if (state.detectedBy !== 'SENDER') {
      return null;
    }

    return (
      <div className="mb-4 flex flex-wrap items-center gap-x-2 text-muted-foreground text-sm">
        <span>
          <Trans>Marcado como não sendo nota fiscal.</Trans>
        </span>
        <Button type="button" variant="link" className="h-11 px-0" disabled={isBusy} onClick={() => void onFlag(true)}>
          <Trans>Desfazer</Trans>
        </Button>
      </div>
    );
  }

  if (state.isInvoice === 'UNKNOWN') {
    return (
      <section className="mb-4 rounded-lg border p-3">
        <p className="font-medium text-sm">
          <Trans>Este documento é uma nota fiscal?</Trans>
        </p>

        <div className="mt-2 flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 flex-1"
            disabled={isBusy}
            onClick={() => void onFlag(true)}
          >
            <Trans>Sim</Trans>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11 flex-1"
            disabled={isBusy}
            onClick={() => void onFlag(false)}
          >
            <Trans>Não</Trans>
          </Button>
        </div>
      </section>
    );
  }

  const { suggestion, choice } = state;
  const suggestionCode = suggestion?.accountCode;
  const suggestionName = suggestion?.accountName;
  const choiceCode = choice?.code;
  const choiceName = choice?.name ?? '';
  const hasFailed = state.suggestionStatus === 'FAILED' || (isPending && hasGivenUp);
  const canResuggest = state.aiAvailable && (state.suggestionStatus === 'DONE' || state.suggestionStatus === 'FAILED');

  return (
    <section className="mb-4 flex flex-col gap-3 rounded-lg border p-3" data-testid="invoice-account-panel">
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <h3 className="font-medium text-sm">
          <Trans>Nota fiscal · Conta contábil</Trans>
        </h3>
        <Button type="button" variant="link" className="h-11 px-0" disabled={isBusy} onClick={() => void onFlag(false)}>
          <Trans>Não é nota fiscal</Trans>
        </Button>
      </div>

      {isPending && !hasGivenUp && (
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <Spinner size="sm" />
          <Trans>Buscando sugestão…</Trans>
        </p>
      )}

      {suggestion && (
        <div className="rounded-md bg-muted/50 p-3 text-sm">
          <p className="font-medium">
            <Trans>
              Sugestão da IA: {suggestionCode} · {suggestionName} (confira)
            </Trans>
          </p>
          {/* Texto puro: o motivo vem da IA e nunca é interpretado como HTML. */}
          <p className="mt-1 break-words text-muted-foreground">{suggestion.reason}</p>

          {choiceCode !== suggestion.accountCode && (
            <Button
              type="button"
              className="mt-2 h-11 w-full sm:w-auto"
              disabled={isBusy}
              onClick={() => void onChoose({ code: suggestion.accountCode })}
            >
              <Trans>Usar sugestão</Trans>
            </Button>
          )}
        </div>
      )}

      {hasFailed && (
        <p className="text-muted-foreground text-sm">
          <Trans>Não foi possível sugerir; escolha na lista</Trans>
        </p>
      )}

      {canResuggest && (
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full sm:w-auto sm:self-start"
          disabled={isBusy}
          onClick={() => void onResuggest()}
        >
          <Trans>Sugerir de novo</Trans>
        </Button>
      )}

      {choice && !isChanging ? (
        <div className="flex flex-wrap items-center justify-between gap-x-2 text-sm">
          <p className="min-w-0 break-words">
            {choiceCode === 'DEFER' ? (
              <Trans>Escolha: deixar para a contabilidade decidir</Trans>
            ) : (
              <Trans>
                Conta escolhida: {choiceCode} · {choiceName}
              </Trans>
            )}
          </p>
          <Button
            type="button"
            variant="link"
            className="h-11 px-0"
            disabled={isBusy}
            onClick={() => setIsChanging(true)}
          >
            <Trans>Trocar</Trans>
          </Button>
        </div>
      ) : (
        <>
          <AccountCombobox
            accounts={accountsData?.accounts ?? []}
            value={choiceCode ?? null}
            disabled={isBusy}
            onSelect={(code) => void onChoose({ code })}
          />

          <Button
            type="button"
            variant="outline"
            className="h-11 w-full whitespace-normal"
            disabled={isBusy}
            onClick={() => void onChoose({ defer: true })}
          >
            <Trans>Deixar para a contabilidade decidir</Trans>
          </Button>
        </>
      )}

      {!choice && (
        <p className="text-amber-700 text-sm dark:text-amber-400">
          <Trans>Escolha a conta contábil ou deixe para a contabilidade decidir.</Trans>
        </p>
      )}
    </section>
  );
};
