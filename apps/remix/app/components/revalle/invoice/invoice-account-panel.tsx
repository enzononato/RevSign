import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { costCenterLabel } from '@documenso/lib/revalle/invoice/cost-centers';
import { formatInvoiceDataLine } from '@documenso/lib/revalle/invoice/invoice-data';
import { isInvoiceFilesReady, isInvoiceReady } from '@documenso/lib/revalle/invoice/invoice-ready';
import { findExternalEmail, formatDomainList, getClientAllowedDomains } from '@documenso/lib/revalle/recipient-domains';
import { trpc } from '@documenso/trpc/react';
import type { TInvoiceState } from '@documenso/trpc/server/revalle-router/invoice/invoice-state.types';
import { Alert, AlertDescription } from '@documenso/ui/primitives/alert';
import { Button } from '@documenso/ui/primitives/button';
import { Spinner } from '@documenso/ui/primitives/spinner';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { AccountCombobox } from './account-combobox';
import { InvoiceAnnotationBoxWarnings, InvoicePdfAnnotationLine } from './annotation-box/invoice-annotation-box-notice';
import { flushAnnotationBoxSaves } from './annotation-box/use-annotation-boxes';
import { CostCenterSelect } from './cost-center-select';
import { InvoiceBoletoBlock } from './invoice-boleto-block';
import { InvoiceDuplicateNotice } from './invoice-duplicate-notice';
import {
  InvoiceFileBlock,
  InvoiceFileSummary,
  InvoiceOtherFileRow,
  InvoiceUnknownFileBlock,
} from './invoice-file-block';
import type { InvoiceFileKindChoice } from './invoice-file-kind-select';

export type InvoiceAccountPanelProps = {
  envelopeId: string;
  /**
   * `false` enquanto a NF não tem a conta e o centro de custo, enquanto "É nota fiscal?" (UNKNOWN) não foi respondida,
   * ou enquanto o estado ainda não chegou: o botão de enviar fica bloqueado.
   */
  onReadyChange: (ready: boolean) => void;
  /**
   * `false` onde o botão de enviar não depende do bloco (o editor antigo): o aviso de nota duplicada aparece, mas sem a
   * caixa "Sei disso e quero enviar mesmo assim", que ali não destravaria nada.
   */
  hasDuplicateAcknowledgement?: boolean;
  /**
   * E-mails dos destinatários do rascunho: nota fiscal só vai para e-mails da empresa. Com um e-mail de fora, o bloco
   * avisa (com o mesmo texto da recusa do servidor) e o envio fica bloqueado.
   */
  recipientEmails?: string[];
  /**
   * `false` no editor antigo, que não tem o bloco "Conta e centro de custo": a linha "No PDF: sem conta e centro (…
   * coloque o bloco …)" não aparece ali.
   */
  hasAnnotationBox?: boolean;
};

const POLL_INTERVAL_MS = 2_000;
// Depois disso a tela desiste de esperar (o servidor desiste em 20 s; aqui sobra margem para o job começar).
const POLL_LIMIT_MS = 30_000;
// O servidor só dá um PENDING esquecido como TIMEOUT depois de 60 s (INVOICE_SUGGESTION_STALE_MS), numa leitura: a
// tela que desistiu consulta uma vez depois disso, para "Sugerir de novo" aparecer sem reabrir o diálogo.
const STALE_REFETCH_MS = 61_000;

const EMPTY_DOCUMENTS: TInvoiceState['documents'] = [];

/** Alguma leitura da IA em andamento: a da nota única (os campos de cima) ou a de algum arquivo (nota ou boleto). */
const isReadingState = (state: TInvoiceState | undefined) =>
  state?.suggestionStatus === 'PENDING' || (state?.documents ?? []).some((doc) => doc.suggestionStatus === 'PENDING');

/**
 * Com uma nota só (e um boleto ao lado), o aviso de duplicada dos campos de cima é o dela: vale para o bloco da nota
 * mesmo que o arquivo ainda não traga o seu.
 */
const withSingleInvoiceDuplicates = (state: TInvoiceState | undefined): TInvoiceState['documents'] => {
  const documents = state?.documents ?? EMPTY_DOCUMENTS;
  const invoices = documents.filter((doc) => doc.kind === 'NF');

  if (!state || invoices.length !== 1 || invoices[0].duplicates.length > 0 || state.duplicates.length === 0) {
    return documents;
  }

  return documents.map((doc) => (doc.kind === 'NF' ? { ...doc, duplicates: state.duplicates } : doc));
};

/**
 * Fase 9: o diálogo mostra um bloco por arquivo quando o envio tem nota e não é o caso de sempre (exatamente uma nota,
 * sem boleto e sem arquivo sem texto). Com uma nota só (e contratos ao lado), o bloco é o de antes, sem cabeçalho. Um
 * arquivo que o remetente tirou da nota ("Não é nota fiscal", "Outro documento") mantém os blocos: o seletor dele
 * continua à mão para desfazer.
 */
const hasPerFileLayout = (documents: TInvoiceState['documents']) => {
  const invoices = documents.filter((doc) => doc.kind === 'NF').length;

  return (
    invoices > 0 &&
    (invoices > 1 ||
      documents.some(
        (doc) =>
          doc.kind === 'BOLETO' || doc.kind === 'UNKNOWN' || (doc.kind === 'OTHER' && doc.detectedBy === 'SENDER'),
      ))
  );
};

/**
 * Bloco "Nota fiscal · Conta contábil" do diálogo de envio, com o centro de custo logo abaixo da conta. Classifica ao
 * abrir, consulta a sugestão enquanto ela está em andamento e grava cada escolha no servidor na hora (o envio confere de
 * novo). A sugestão nunca vira escolha sozinha.
 */
export const InvoiceAccountPanel = ({
  envelopeId,
  onReadyChange,
  hasDuplicateAcknowledgement = true,
  recipientEmails = [],
  hasAnnotationBox = true,
}: InvoiceAccountPanelProps) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const [isClassified, setIsClassified] = useState(false);
  const [hasGivenUp, setHasGivenUp] = useState(false);
  const [isChanging, setIsChanging] = useState(false);
  // Fase 8: "Sei disso e quero enviar mesmo assim", diante do aviso de nota duplicada.
  const [isDuplicateAcknowledged, setIsDuplicateAcknowledged] = useState(false);
  // Fase 9: com várias notas, a confirmação é de cada nota (`envelopeItemId`).
  const [acknowledgedDuplicateIds, setAcknowledgedDuplicateIds] = useState<ReadonlySet<string>>(() => new Set());
  const pendingSince = useRef<number | null>(null);

  const { mutateAsync: classify } = trpc.revalle.invoice.classify.useMutation();
  const { mutateAsync: setChoice, isPending: isSavingChoice } = trpc.revalle.invoice.setChoice.useMutation();
  const { mutateAsync: setCostCenter, isPending: isSavingCostCenter } =
    trpc.revalle.invoice.setCostCenter.useMutation();
  const { mutateAsync: setInvoiceFlag, isPending: isSavingFlag } = trpc.revalle.invoice.setInvoiceFlag.useMutation();
  const { mutateAsync: resuggest, isPending: isResuggesting } = trpc.revalle.invoice.resuggest.useMutation();
  const { mutateAsync: setFileKind, isPending: isSavingKind } = trpc.revalle.invoice.setFileKind.useMutation();

  // Uma consulta em andamento (a espera da sugestão) não pode sobrescrever o que acabou de ser gravado: cancela antes.
  const store = async (state: TInvoiceState) => {
    await utils.revalle.invoice.get.cancel({ envelopeId });
    utils.revalle.invoice.get.setData({ envelopeId }, state);
  };

  useEffect(() => {
    // Os arquivos podem ter mudado no editor: classifica (só refaz a detecção se mudaram). Antes, o bloco de conta e centro
    // que acabou de ser movido no editor termina de gravar: o estado traz a página certa.
    flushAnnotationBoxSaves()
      .then(async () => await classify({ envelopeId }))
      .then(store)
      .catch(() => undefined)
      .finally(() => setIsClassified(true));
  }, [envelopeId]);

  const {
    data: state,
    isError,
    refetch,
  } = trpc.revalle.invoice.get.useQuery(
    { envelopeId },
    {
      ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
      enabled: isClassified,
      refetchInterval: (query) => (isReadingState(query.state.data) && !hasGivenUp ? POLL_INTERVAL_MS : false),
    },
  );

  // Fase 9: a espera (e a desistência) vale para qualquer leitura do envio; com uma nota só, é a dela, como antes.
  const isPending = isReadingState(state);

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

  useEffect(() => {
    if (!isPending || !hasGivenUp) {
      return;
    }

    const elapsed = Date.now() - (pendingSince.current ?? Date.now());
    const timer = setTimeout(() => void refetch(), Math.max(0, STALE_REFETCH_MS - elapsed));

    return () => clearTimeout(timer);
  }, [isPending, hasGivenUp]);

  const isInvoice = state?.isInvoice === 'YES';
  // O aviso pode aparecer depois do diálogo aberto (a chave que a IA leu numa NF escaneada chega com a sugestão).
  const duplicates = isInvoice ? (state?.duplicates ?? []) : [];

  const documents = withSingleInvoiceDuplicates(state);
  const isPerFile = hasPerFileLayout(documents);
  // As notas com aviso de duplicada, numa chave estável: a confirmação de uma nota some quando o aviso dela some.
  const duplicatedIdsKey = documents
    .filter((doc) => doc.kind === 'NF' && doc.duplicates.length > 0)
    .map((doc) => doc.envelopeItemId)
    .join(',');

  // A confirmação vale para este documento e para este aviso: ao trocar de documento, ou quando o aviso some, zera.
  useEffect(() => {
    setIsDuplicateAcknowledged(false);
    setAcknowledgedDuplicateIds(new Set());
  }, [envelopeId]);

  useEffect(() => {
    const duplicated = new Set(duplicatedIdsKey.split(',').filter(Boolean));

    setAcknowledgedDuplicateIds((current) =>
      [...current].every((id) => duplicated.has(id))
        ? current
        : new Set([...current].filter((id) => duplicated.has(id))),
    );
  }, [duplicatedIdsKey]);

  useEffect(() => {
    if (duplicates.length === 0) {
      setIsDuplicateAcknowledged(false);
    }
  }, [duplicates.length]);

  const { data: accountsData } = trpc.revalle.invoice.findAccounts.useQuery(undefined, {
    ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
    enabled: isInvoice,
  });

  // O diálogo desmonta o bloco ao fechar: ao abrir de novo, o estado guardado da vez anterior não libera o envio
  // antes da classificação nova (os arquivos podem ter mudado). Sem estado (erro na consulta), o envio segue: o
  // servidor confere de qualquer forma. Escaneado (UNKNOWN) só libera com "Sim" (e a conta) ou "Não": uma NF tirada
  // no celular não pode sair do fluxo da contabilidade com um toque em "Enviar". O servidor não exige a resposta (API).
  // Nova versão de uma troca de conta com o envio do Financeiro em andamento: quem envia agora é o Financeiro. Nova versão
  // cujo envio falhou: a conta e o centro ficam travados, mas o rascunho pode sair por aqui. Sem nenhuma conta ativa na
  // lista, nenhuma nota fiscal sai (mesmo com uma escolha antiga). A conta e o centro são exigidos no primeiro envio: a
  // nova versão com o envio parado (`isReleased`) leva o que a anterior tinha.
  const isReleased = isInvoice && state?.isFinanceSendReleased === true;
  const isHeld = isInvoice && !isReleased && state?.financeStatus === 'APPROVED';
  const hasNoAccounts = isInvoice && accountsData !== undefined && accountsData.accounts.length === 0;
  const allowedDomains = getClientAllowedDomains();
  const externalRecipientEmail = isInvoice ? findExternalEmail(recipientEmails, allowedDomains) : null;
  const readyInput = {
    isClassified,
    isError,
    isHeld,
    hasNoAccounts,
    requiresChoice: !isReleased,
    requiresCostCenter: !isReleased,
  };
  // Com 2+ notas e nenhuma duplicada por arquivo ainda, o aviso do envio (a união das notas) vale para todas, com uma
  // confirmação só: a proteção da Fase 8 não some enquanto as notas não trazem o aviso delas.
  const showEnvelopeDuplicates =
    isPerFile && duplicates.length > 0 && documents.every((doc) => doc.duplicates.length === 0);
  const isReady =
    !externalRecipientEmail &&
    (isPerFile
      ? isInvoiceFilesReady({ ...readyInput, acknowledgedDuplicateIds, state: state && { ...state, documents } }) &&
        (!showEnvelopeDuplicates || isDuplicateAcknowledged)
      : isInvoiceReady({ ...readyInput, duplicateAcknowledged: isDuplicateAcknowledged, state }));

  useEffect(() => {
    onReadyChange(isReady);
  }, [isReady]);

  const showError = () =>
    toast({ title: t`Não foi possível salvar. Tente de novo.`, variant: 'destructive', duration: 5000 });

  const onChoose = async (choice: { code: string }) => {
    try {
      await store(await setChoice({ envelopeId, choice }));
      setIsChanging(false);
    } catch {
      showError();
    }
  };

  const onChooseCostCenter = async (code: string) => {
    try {
      await store(await setCostCenter({ envelopeId, code }));
    } catch {
      showError();
    }
  };

  const onFlag = async (value: boolean) => {
    try {
      await store(await setInvoiceFlag({ envelopeId, isInvoice: value }));
    } catch {
      showError();
    }
  };

  const onResuggest = async (envelopeItemId?: string) => {
    try {
      await store(await resuggest({ envelopeId, envelopeItemId }));
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

  // Fase 9: as gravações de uma nota (`envelopeItemId`) no diálogo com um bloco por arquivo.
  const onChooseFile = async (envelopeItemId: string, code: string) => {
    try {
      await store(await setChoice({ envelopeId, envelopeItemId, choice: { code } }));

      return true;
    } catch {
      showError();

      return false;
    }
  };

  const onChooseFileCostCenter = async (envelopeItemId: string, code: string) => {
    try {
      await store(await setCostCenter({ envelopeId, envelopeItemId, code }));
    } catch {
      showError();
    }
  };

  const onFileKind = async (envelopeItemId: string, kind: InvoiceFileKindChoice) => {
    try {
      await store(await setFileKind({ envelopeId, envelopeItemId, kind }));
    } catch {
      showError();
    }
  };

  const onAcknowledgeFile = (envelopeItemId: string, checked: boolean) =>
    setAcknowledgedDuplicateIds((current) => {
      const next = new Set(current);

      if (checked) {
        next.add(envelopeItemId);
      } else {
        next.delete(envelopeItemId);
      }

      return next;
    });

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

  const isBusy = isSavingChoice || isSavingCostCenter || isSavingFlag || isResuggesting || isSavingKind;
  const domainList = formatDomainList(allowedDomains);
  // Mesmo texto da recusa do servidor (`formatInvoiceExternalRecipientMessage`).
  const externalNotice = externalRecipientEmail ? (
    <Alert variant="destructive" className="py-3" data-testid="invoice-external-recipient">
      <AlertDescription className="break-words">
        {t`Invoices can only be sent to company e-mails (${domainList}). Change the e-mail of ${externalRecipientEmail}.`}
      </AlertDescription>
    </Alert>
  ) : null;
  // O bloco "Conta e centro de custo" posto no editor: o que sai no PDF de cada nota, e o aviso do bloco fora de nota.
  const pdfLineOf = (envelopeItemId: string | null) => (
    <InvoicePdfAnnotationLine state={state} envelopeItemId={envelopeItemId} hasAnnotationBox={hasAnnotationBox} />
  );
  const annotationWarnings = <InvoiceAnnotationBoxWarnings state={state} />;
  const singleInvoiceItemId = documents.find((doc) => doc.kind === 'NF')?.envelopeItemId ?? null;
  const duplicateNotice = (
    <InvoiceDuplicateNotice
      duplicates={duplicates}
      acknowledgement={
        hasDuplicateAcknowledgement
          ? { checked: isDuplicateAcknowledged, onChange: setIsDuplicateAcknowledged }
          : undefined
      }
    />
  );

  if (isPerFile) {
    const acknowledgementOf = (envelopeItemId: string) =>
      hasDuplicateAcknowledgement
        ? {
            checked: acknowledgedDuplicateIds.has(envelopeItemId),
            onChange: (checked: boolean) => onAcknowledgeFile(envelopeItemId, checked),
          }
        : undefined;
    const invoiceDocuments = documents.filter((doc) => doc.kind === 'NF');
    const lockedNotice = isReleased ? (
      state.financeStatus === 'APPROVED' ? (
        <Trans>Conta aprovada pelo Financeiro. O envio anterior falhou: corrija o rascunho e envie.</Trans>
      ) : (
        <Trans>O envio anterior falhou: corrija o rascunho e envie.</Trans>
      )
    ) : isHeld ? (
      <Trans>O Financeiro está enviando esta nova versão. Os convites saem em instantes.</Trans>
    ) : null;

    // Nova versão: a conta e o centro de cada nota ficam travados; só leitura, nota por nota.
    if (lockedNotice) {
      return (
        <section className="mb-4 flex flex-col gap-2 rounded-[13px] border p-3" data-testid="invoice-account-panel">
          <h3 className="font-medium text-sm">
            <Trans>Notas fiscais · Conta contábil</Trans>
          </h3>
          {isReleased && externalNotice}
          {isReleased && showEnvelopeDuplicates && duplicateNotice}
          {invoiceDocuments.map((doc) => (
            <InvoiceFileSummary key={doc.envelopeItemId} document={doc}>
              {/* O rascunho parado sai por aqui: a duplicada de cada nota ainda pede a confirmação (como com uma nota). */}
              {isReleased && (
                <InvoiceDuplicateNotice
                  duplicates={doc.duplicates}
                  acknowledgement={acknowledgementOf(doc.envelopeItemId)}
                />
              )}
              {pdfLineOf(doc.envelopeItemId)}
            </InvoiceFileSummary>
          ))}
          {annotationWarnings}
          <p className="text-muted-foreground text-sm">{lockedNotice}</p>
        </section>
      );
    }

    const blockOf = (doc: TInvoiceState['documents'][number]): ReactNode => {
      const envelopeItemId = doc.envelopeItemId;

      switch (doc.kind) {
        case 'NF':
          return (
            <InvoiceFileBlock
              key={envelopeItemId}
              document={doc}
              accounts={accountsData?.accounts ?? []}
              hasNoAccounts={hasNoAccounts}
              aiAvailable={state.aiAvailable}
              hasGivenUp={hasGivenUp}
              disabled={isBusy}
              acknowledgement={acknowledgementOf(envelopeItemId)}
              onChoose={async (code) => await onChooseFile(envelopeItemId, code)}
              onChooseCostCenter={(code) => void onChooseFileCostCenter(envelopeItemId, code)}
              onResuggest={() => void onResuggest(envelopeItemId)}
              onNotInvoice={() => void onFileKind(envelopeItemId, 'OTHER')}
              pdfLine={pdfLineOf(envelopeItemId)}
            />
          );
        case 'BOLETO':
          return (
            <InvoiceBoletoBlock
              key={envelopeItemId}
              document={doc}
              hasGivenUp={hasGivenUp}
              disabled={isBusy}
              onNotBoleto={() => void onFileKind(envelopeItemId, 'OTHER')}
            />
          );
        case 'UNKNOWN':
          return (
            <InvoiceUnknownFileBlock
              key={envelopeItemId}
              document={doc}
              disabled={isBusy}
              onSelect={(kind) => void onFileKind(envelopeItemId, kind)}
            />
          );
        default:
          return (
            <InvoiceOtherFileRow
              key={envelopeItemId}
              document={doc}
              disabled={isBusy}
              onSelect={(kind) => void onFileKind(envelopeItemId, kind)}
            />
          );
      }
    };

    return (
      <section className="mb-4 flex min-w-0 flex-col gap-3" data-testid="invoice-account-panel">
        <h3 className="font-medium text-sm">
          <Trans>Notas fiscais · Conta contábil</Trans>
        </h3>

        {externalNotice}

        {showEnvelopeDuplicates && duplicateNotice}

        {hasNoAccounts && (
          <p className="text-sm text-warning-text">
            <Trans>Nenhuma conta contábil cadastrada. Fale com o administrador.</Trans>
          </p>
        )}

        {documents.map(blockOf)}

        {annotationWarnings}
      </section>
    );
  }

  if (state.isInvoice === 'NO') {
    // Só quem marcou "Não é nota fiscal" vê o desfazer; documento comum não muda em nada (só o aviso de um bloco de conta e
    // centro posto nele, que não sai no PDF).
    if (state.detectedBy !== 'SENDER') {
      return <div className="mb-4 empty:hidden">{annotationWarnings}</div>;
    }

    return (
      <div className="mb-4 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-sm">
          <span>
            <Trans>Você marcou que não é nota fiscal.</Trans>
          </span>
          <Button
            type="button"
            variant="link"
            className="h-11 px-0"
            disabled={isBusy}
            onClick={() => void onFlag(true)}
          >
            <Trans>Desfazer</Trans>
          </Button>
        </div>
        {annotationWarnings}
      </div>
    );
  }

  if (state.isInvoice === 'UNKNOWN') {
    return (
      <section className="mb-4 rounded-[13px] border p-3" data-testid="invoice-question">
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

        <p className="mt-2 text-sm text-warning-text">
          <Trans>Responda para enviar</Trans>
        </p>
      </section>
    );
  }

  if (isReleased) {
    return (
      <section className="mb-4 flex flex-col gap-1 rounded-[13px] border p-3" data-testid="invoice-account-panel">
        <h3 className="font-medium text-sm">
          <Trans>Nota fiscal · Conta contábil</Trans>
        </h3>
        {externalNotice}
        {duplicateNotice}
        <p className="text-sm">
          {state.choice?.name ? `${state.choice.code} – ${state.choice.name}` : (state.choice?.code ?? '-')}
        </p>
        {state.costCenter && (
          <p className="text-sm">
            <Trans>Centro de custo: {costCenterLabel(state.costCenter.code)}</Trans>
          </p>
        )}
        {pdfLineOf(singleInvoiceItemId)}
        {annotationWarnings}
        <p className="text-muted-foreground text-sm">
          {state.financeStatus === 'APPROVED' ? (
            <Trans>Conta aprovada pelo Financeiro. O envio anterior falhou: corrija o rascunho e envie.</Trans>
          ) : (
            <Trans>O envio anterior falhou: corrija o rascunho e envie.</Trans>
          )}
        </p>
      </section>
    );
  }

  if (isHeld) {
    return (
      <section className="mb-4 flex flex-col gap-1 rounded-[13px] border p-3" data-testid="invoice-account-panel">
        <h3 className="font-medium text-sm">
          <Trans>Nota fiscal · Conta contábil</Trans>
        </h3>
        <p className="text-sm">
          {state.choice?.name ? `${state.choice.code} – ${state.choice.name}` : state.choice?.code}
        </p>
        {state.costCenter && (
          <p className="text-sm">
            <Trans>Centro de custo: {costCenterLabel(state.costCenter.code)}</Trans>
          </p>
        )}
        {pdfLineOf(singleInvoiceItemId)}
        <p className="text-muted-foreground text-sm">
          <Trans>O Financeiro está enviando esta nova versão. Os convites saem em instantes.</Trans>
        </p>
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
  // Fase 8: fornecedor, número e valor que a IA leu; só o que existe. Texto puro, como o motivo.
  const invoiceDataLine = formatInvoiceDataLine(state.invoiceData);

  return (
    <section className="mb-4 flex flex-col gap-3 rounded-[13px] border p-3" data-testid="invoice-account-panel">
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <h3 className="font-medium text-sm">
          <Trans>Nota fiscal · Conta contábil</Trans>
        </h3>
        <Button type="button" variant="link" className="h-11 px-0" disabled={isBusy} onClick={() => void onFlag(false)}>
          <Trans>Não é nota fiscal</Trans>
        </Button>
      </div>

      {externalNotice}

      {duplicateNotice}

      {isPending && !hasGivenUp && (
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <Spinner size="sm" />
          <Trans>Buscando sugestão…</Trans>
        </p>
      )}

      {suggestion && (
        <div className="rounded-[10px] bg-muted/60 p-3 text-sm">
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

      {invoiceDataLine && (
        <p className="break-words text-muted-foreground text-sm" data-testid="invoice-data-line">
          <Trans>Lido pela IA: {invoiceDataLine}</Trans>
        </p>
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

      {choice && !isChanging && (
        <div className="flex flex-wrap items-center justify-between gap-x-2 text-sm">
          <p className="min-w-0 break-words">
            <Trans>
              Conta escolhida: {choiceCode} · {choiceName}
            </Trans>
          </p>
          {!hasNoAccounts && (
            <Button
              type="button"
              variant="link"
              className="h-11 px-0"
              disabled={isBusy}
              onClick={() => setIsChanging(true)}
            >
              <Trans>Trocar</Trans>
            </Button>
          )}
        </div>
      )}

      {hasNoAccounts && (
        <p className="text-sm text-warning-text">
          <Trans>Nenhuma conta contábil cadastrada. Fale com o administrador.</Trans>
        </p>
      )}

      {(!choice || isChanging) && !hasNoAccounts && (
        <AccountCombobox
          accounts={accountsData?.accounts ?? []}
          value={choiceCode ?? null}
          disabled={isBusy}
          onSelect={(code) => void onChoose({ code })}
        />
      )}

      {!choice && !hasNoAccounts && (
        <p className="text-sm text-warning-text">
          <Trans>Escolha a conta contábil.</Trans>
        </p>
      )}

      <CostCenterSelect
        value={state.costCenter?.code ?? null}
        disabled={isBusy}
        onSelect={(code) => void onChooseCostCenter(code)}
      />

      {!state.costCenter && (
        <p className="text-sm text-warning-text">
          <Trans>Escolha o centro de custo.</Trans>
        </p>
      )}

      {pdfLineOf(singleInvoiceItemId)}

      {annotationWarnings}
    </section>
  );
};
