import { formatPath } from '@documenso/lib/constants/app';
import { AppError } from '@documenso/lib/errors/app-error';
import type { SignatureRect } from '@documenso/lib/revalle/collaborator-contract-rect';
import type { PreviewResult } from '@documenso/lib/revalle/collaborator-rows';
import { formatDomainList, getClientAllowedDomains, isExternalEmail } from '@documenso/lib/revalle/recipient-domains';
import { trpc } from '@documenso/trpc/react';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowLeftIcon, CheckIcon, CloudIcon, CloudOffIcon, Loader2Icon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { countPdfPages, type PdfSource, usePdfDocument } from './contract-pdf';
import { CONTRACTS_PATH, contractPath, contractPdfPath, EmptyState, errorMessage, PageCard } from './contract-ui';
import { type BoxKind, type ContractBoxes, defaultBoxes, fitBoxesToPages } from './signature-boxes';
import { type ListMode, StepCollaborators } from './step-collaborators';
import { CONTRACT_PDF_MAX_MB, StepContract } from './step-contract';
import { StepRepresentative } from './step-representative';
import { ConfirmSendDialog, StepReview } from './step-review';

// REVALLE (v.22): assistente "Novo contrato": Contrato → Representante → Colaboradores → Revisar e enviar. O rascunho é
// gravado sozinho (sem a lista, que não fica guardada) e pode ser retomado pela lista (`?id=`).

const COMPLETE_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SAVE_DEBOUNCE_MS = 800;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

type DraftFields = {
  title: string | null;
  senderName: string | null;
  documentDataId: string | null;
  representativeEmail: string | null;
  representativeRect: SignatureRect | null;
  collaboratorRect: SignatureRect | null;
};

export type ContractWizardProps = {
  /** Rascunho a continuar (`?id=`), ou null para um contrato novo. */
  draftId: string | null;
  /** E-mails por hora da varredura (para a estimativa). */
  perHour: number;
};

export const ContractWizard = ({ draftId, perHour }: ContractWizardProps) => {
  const { t } = useLingui();
  const navigate = useNavigate();

  const stepLabels = [t`Contrato`, t`Representante`, t`Colaboradores`, t`Revisar e enviar`];

  // Rascunho retomado.
  const draftQuery = trpc.revalle.collaboratorContract.page.get.useQuery(
    { contractId: draftId ?? '' },
    { enabled: draftId !== null, retry: false, refetchOnWindowFocus: false, staleTime: Number.POSITIVE_INFINITY },
  );
  const [isHydrated, setIsHydrated] = useState(draftId === null);

  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [showErrors, setShowErrors] = useState<Record<number, boolean>>({});

  // Passo 1.
  const [title, setTitle] = useState('');
  const [documentDataId, setDocumentDataId] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [pdfSource, setPdfSource] = useState<PdfSource | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<ContractBoxes | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const pdfState = usePdfDocument(pdfSource);
  const pageCount = pdfState.status === 'ready' ? pdfState.pdf.numPages : null;

  // Passo 2.
  const [representativeEmail, setRepresentativeEmail] = useState('');
  const [accountName, setAccountName] = useState<string | null>(null);

  // Passo 3.
  const [listMode, setListMode] = useState<ListMode>('paste');
  const [listText, setListText] = useState('');
  const [listFileName, setListFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewOrigin, setPreviewOrigin] = useState<ListMode | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [isCheckingList, setIsCheckingList] = useState(false);
  const checkNowRef = useRef<(() => Promise<PreviewResult | null>) | null>(null);
  // Na aba "Colar", a caixa vale: texto mudado depois da última conferência ainda não pode ser enviado.
  const isListStale =
    listMode === 'paste' && listText.trim() !== '' && (previewOrigin !== 'paste' || listText !== previewText);

  // Passo 4.
  const [senderName, setSenderName] = useState('');
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Rascunho.
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const contractIdRef = useRef<string | null>(draftId);
  const lastSavedRef = useRef<string | null>(null);
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const isSentRef = useRef(false);

  const saveDraftMutation = trpc.revalle.collaboratorContract.page.saveDraft.useMutation({
    meta: { doNotInvalidateQueryOnMutation: true },
  });
  const createMutation = trpc.revalle.collaboratorContract.page.create.useMutation();

  // Continua o rascunho: os campos, o PDF (pela rota do administrador) e o primeiro passo que falta.
  useEffect(() => {
    const data = draftQuery.data;

    if (!data || isHydrated) {
      return;
    }

    const { contract } = data;

    if (contract.status !== 'DRAFT') {
      void navigate(contractPath(contract.id), { replace: true });

      return;
    }

    setTitle(contract.title ?? '');
    setSenderName(contract.senderName ?? '');
    setRepresentativeEmail(contract.representativeEmail ?? '');
    setDocumentDataId(contract.documentDataId);

    if (contract.documentDataId) {
      setPdfSource({ kind: 'url', url: contractPdfPath(contract.id) });
    }

    if (contract.representativeRect && contract.collaboratorRect) {
      setBoxes({ representative: contract.representativeRect, collaborator: contract.collaboratorRect });
      setCurrentPage(contract.collaboratorRect.page);
    }

    lastSavedRef.current = JSON.stringify({
      title: contract.title || null,
      senderName: contract.senderName || null,
      documentDataId: contract.documentDataId,
      representativeEmail: contract.representativeEmail || null,
      representativeRect: contract.representativeRect,
      collaboratorRect: contract.collaboratorRect,
    } satisfies DraftFields);

    const firstMissing = !contract.title || !contract.documentDataId ? 0 : !contract.representativeEmail ? 1 : 2;

    setStep(firstMissing);
    setMaxStep(firstMissing);
    setIsHydrated(true);
  }, [draftQuery.data]);

  // PDF aberto: os quadros começam na última página (ou voltam para dentro do PDF novo).
  useEffect(() => {
    if (pdfState.status !== 'ready') {
      return;
    }

    const pages = pdfState.pdf.numPages;
    const next = boxes ? fitBoxesToPages(boxes, pages) : defaultBoxes(pages);

    setBoxes(next);
    setCurrentPage(boxes ? Math.min(Math.max(currentPage, 1), pages) : next.collaborator.page);
  }, [pdfState]);

  const draftFields = useMemo<DraftFields>(
    () => ({
      title: title.trim() || null,
      senderName: senderName.trim() || null,
      documentDataId,
      representativeEmail: representativeEmail.trim() || null,
      representativeRect: boxes?.representative ?? null,
      collaboratorRect: boxes?.collaborator ?? null,
    }),
    [title, senderName, documentDataId, representativeEmail, boxes],
  );

  /** Grava o rascunho, uma gravação de cada vez (a primeira cria o contrato e as outras esperam o id). */
  const saveDraft = (fields: DraftFields) => {
    const run = async () => {
      const serialized = JSON.stringify(fields);

      // Sem o PDF subido não nasce rascunho (só um título não deixa nada para continuar).
      if (isSentRef.current || !fields.documentDataId || serialized === lastSavedRef.current) {
        return;
      }

      setSaveState('saving');

      try {
        const result = await saveDraftMutation.mutateAsync({
          contractId: contractIdRef.current ?? undefined,
          data: fields,
        });

        const isNew = contractIdRef.current === null;

        contractIdRef.current = result.contractId;

        if (isNew) {
          // O endereço passa a ter o rascunho: recarregar a página continua daqui (a rota lê o id só ao abrir).
          void navigate(
            { search: `?id=${encodeURIComponent(result.contractId)}` },
            { replace: true, preventScrollReset: true },
          );
        }

        lastSavedRef.current = serialized;
        setSaveState('saved');
      } catch (err) {
        if (AppError.parseError(err).statusCode === 409 && contractIdRef.current) {
          isSentRef.current = true;
          void navigate(contractPath(contractIdRef.current), { replace: true });

          return;
        }

        setSaveState('error');
      }
    };

    const next = saveChainRef.current.then(run, run);

    saveChainRef.current = next;

    return next;
  };

  // Grava sozinho depois de uma pausa, a partir do momento em que o PDF subiu.
  useEffect(() => {
    if (!isHydrated || isSentRef.current || !draftFields.documentDataId) {
      return;
    }

    const timer = setTimeout(() => void saveDraft(draftFields), SAVE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [draftFields, isHydrated]);

  const onPdfFile = async (file: File) => {
    setPdfError(null);

    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setPdfError(t`Escolha um arquivo PDF.`);

      return;
    }

    if (file.size > CONTRACT_PDF_MAX_MB * 1024 * 1024) {
      setPdfError(t`O PDF tem mais de ${CONTRACT_PDF_MAX_MB} MB. Diminua o arquivo e tente de novo.`);

      return;
    }

    setIsUploading(true);

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());

      try {
        await countPdfPages(bytes);
      } catch {
        setPdfError(t`Não foi possível abrir este PDF. Ele pode estar protegido por senha ou danificado.`);

        return;
      }

      const uploaded = await uploadContractPdf(file);

      if ('error' in uploaded) {
        setPdfError(
          uploaded.error === 'INVALID'
            ? t`O arquivo não é um PDF válido ou passou de ${CONTRACT_PDF_MAX_MB} MB. Confira e tente de novo.`
            : t`Não foi possível subir o PDF agora. Tente de novo em instantes.`,
        );

        return;
      }

      setDocumentDataId(uploaded.id);
      setFileName(file.name);
      setPdfSource({ kind: 'bytes', data: bytes });
    } catch {
      setPdfError(t`Não foi possível subir o PDF agora. Tente de novo em instantes.`);
    } finally {
      setIsUploading(false);
    }
  };

  const onBoxChange = (kind: BoxKind, rect: SignatureRect) => {
    setBoxes((previous) => (previous ? { ...previous, [kind]: rect } : previous));
  };

  const domains = getClientAllowedDomains();

  const readyRows = useMemo(
    () =>
      (preview?.rows ?? [])
        .filter((row) => row.issues.length === 0)
        .map((row) => ({ name: row.name, email: row.email, cpf: row.cpf })),
    [preview],
  );

  /** O erro de cada passo, ou null quando dá para seguir. */
  const stepError = (index: number): string | null => {
    if (index === 0) {
      if (!title.trim()) {
        return t`Dê um título ao contrato.`;
      }

      if (isUploading) {
        return t`Espere o PDF terminar de subir.`;
      }

      if (!documentDataId) {
        return t`Suba o PDF do contrato.`;
      }

      if (!boxes || pdfState.status !== 'ready') {
        return pdfState.status === 'error'
          ? t`Não foi possível abrir a prévia do PDF. Escolha o arquivo de novo.`
          : t`Espere a prévia do PDF carregar.`;
      }

      return null;
    }

    if (index === 1) {
      const email = representativeEmail.trim();

      if (!COMPLETE_EMAIL.test(email)) {
        return t`Digite o e-mail do representante, por exemplo nome@revalle.com.br.`;
      }

      if (domains.length > 0 && isExternalEmail(email, domains)) {
        return t`O representante assina pela empresa: use um e-mail ${formatDomainList(domains)}.`;
      }

      return null;
    }

    if (index === 2) {
      if (isCheckingList || isListStale) {
        return t`Espere a conferência da lista terminar.`;
      }

      if (!preview) {
        return t`Cole a lista ou suba o arquivo dos colaboradores.`;
      }

      if (readyRows.length === 0) {
        return t`Nenhuma linha está pronta. Corrija a planilha e cole de novo.`;
      }

      return null;
    }

    return null;
  };

  const titleError = showErrors[0] && !title.trim() ? t`Dê um título ao contrato.` : null;
  const step0Error = showErrors[0] ? stepError(0) : null;
  const pdfStepError = pdfError ?? (step0Error && step0Error !== titleError ? step0Error : null);

  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const isFirstStepRender = useRef(true);

  // Leitor de tela e teclado começam o passo novo pelo título dele.
  useEffect(() => {
    if (isFirstStepRender.current) {
      isFirstStepRender.current = false;

      return;
    }

    stepHeadingRef.current?.focus({ preventScroll: true });
  }, [step]);

  const goTo = (index: number) => {
    setStep(index);
    setMaxStep((max) => Math.max(max, index));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const onContinue = async () => {
    // Lista colada mudada e ainda na pausa da conferência: confere agora e segue com o resultado.
    if (step === 2 && isListStale && !isCheckingList && checkNowRef.current) {
      const result = await checkNowRef.current();

      if (!result || result.ready === 0) {
        setShowErrors((previous) => ({ ...previous, [step]: true }));

        return;
      }

      void saveDraft(draftFields);
      goTo(step + 1);

      return;
    }

    const error = stepError(step);

    if (error) {
      setShowErrors((previous) => ({ ...previous, [step]: true }));

      return;
    }

    void saveDraft(draftFields);
    goTo(step + 1);
  };

  const onOpenConfirm = () => {
    // Algo mudou num passo anterior (por exemplo, o PDF trocado): volta lá.
    const firstError = [0, 1, 2].find((index) => stepError(index) !== null);

    if (firstError !== undefined) {
      setShowErrors((previous) => ({ ...previous, [firstError]: true }));
      goTo(firstError);

      return;
    }

    setSendError(null);
    setIsConfirmOpen(true);
  };

  const onSend = async () => {
    if (!documentDataId || !boxes) {
      return;
    }

    setSendError(null);

    // O rascunho desta tela vira o contrato (e não um segundo contrato).
    await saveChainRef.current.catch(() => undefined);

    try {
      const result = await createMutation.mutateAsync({
        contractId: contractIdRef.current ?? undefined,
        title: title.trim(),
        senderName: senderName.trim() || undefined,
        documentDataId,
        representativeEmail: representativeEmail.trim(),
        representativeRect: boxes.representative,
        collaboratorRect: boxes.collaborator,
        rows: readyRows,
      });

      isSentRef.current = true;
      setIsConfirmOpen(false);
      // O contrato existe, mas o convite ao representante não saiu: a página do contrato mostra o aviso e o reenvio.
      void navigate(contractPath(result.contractId), {
        state: result.warning === 'REPRESENTATIVE_NOT_SENT' ? { representativeNotSent: true } : undefined,
      });
    } catch (err) {
      const error = AppError.parseError(err);

      if (error.statusCode === 409 && contractIdRef.current) {
        isSentRef.current = true;
        void navigate(contractPath(contractIdRef.current));

        return;
      }

      setSendError(errorMessage(err, t`Não foi possível enviar. Tente de novo.`));
    }
  };

  if (draftId !== null && !isHydrated) {
    return (
      <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 md:px-8">
        <EmptyState testId="wizard-loading">
          {draftQuery.isError ? (
            <>
              <p>
                <Trans>Não foi possível abrir o rascunho. Ele pode ter sido enviado ou apagado.</Trans>
              </p>
              <Button asChild variant="outline">
                <Link to={CONTRACTS_PATH}>
                  <Trans>Voltar para a lista</Trans>
                </Link>
              </Button>
            </>
          ) : (
            <p>
              <Trans>Carregando o rascunho…</Trans>
            </p>
          )}
        </EmptyState>
      </div>
    );
  }

  const currentError = showErrors[step] ? stepError(step) : null;
  const isLastStep = step === stepLabels.length - 1;

  return (
    <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 md:px-8" data-testid="contract-wizard">
      <Link
        to={CONTRACTS_PATH}
        className="inline-flex items-center gap-1.5 rounded-sm font-bold text-brand-text text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeftIcon className="h-4 w-4" aria-hidden />
        <Trans>Contratos para colaboradores</Trans>
      </Link>

      <div className="mt-2 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <h1 className="font-black font-display text-[30px] leading-[1.05] tracking-[-0.03em] md:text-[36px]">
          <Trans>Novo contrato</Trans>
        </h1>
        <SaveIndicator state={saveState} onRetry={() => void saveDraft(draftFields)} />
      </div>

      <WizardStepper labels={stepLabels} step={step} maxStep={maxStep} onSelect={goTo} />

      <PageCard className="mt-5 md:p-7" testId={`wizard-step-${step + 1}`}>
        <h2
          ref={stepHeadingRef}
          tabIndex={-1}
          className="mb-5 rounded-sm font-display font-extrabold text-[22px] leading-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="wizard-step-heading"
        >
          <span className="text-muted-foreground">{step + 1}.</span> {stepLabels[step]}
        </h2>

        {step === 0 && (
          <StepContract
            title={title}
            onTitleChange={setTitle}
            titleError={titleError}
            fileName={fileName}
            hasPdf={documentDataId !== null}
            pdfState={pdfState}
            pdfError={pdfStepError}
            isUploading={isUploading}
            onFile={(file) => void onPdfFile(file)}
            boxes={boxes}
            onBoxChange={onBoxChange}
            currentPage={currentPage}
            onPageChange={setCurrentPage}
          />
        )}

        {step === 1 && (
          <StepRepresentative
            email={representativeEmail}
            onEmailChange={setRepresentativeEmail}
            error={currentError}
            onAccountName={setAccountName}
          />
        )}

        {step === 2 && (
          <StepCollaborators
            mode={listMode}
            onModeChange={setListMode}
            text={listText}
            onTextChange={setListText}
            fileName={listFileName}
            onFileName={setListFileName}
            preview={preview}
            previewOrigin={previewOrigin}
            previewText={previewText}
            onPreview={(result, origin, text) => {
              setPreview(result);
              setPreviewOrigin(origin);
              setPreviewText(text);
            }}
            checkNowRef={checkNowRef}
            onCheckingChange={setIsCheckingList}
            isResumed={draftId !== null}
            error={currentError}
          />
        )}

        {step === 3 && (
          <StepReview
            title={title}
            pageCount={pageCount}
            representativeEmail={representativeEmail}
            representativeAccountName={accountName}
            readyCount={readyRows.length}
            skippedCount={(preview?.rows.length ?? 0) - readyRows.length}
            senderName={senderName}
            onSenderNameChange={setSenderName}
            perHour={perHour}
            onEditStep={goTo}
          />
        )}

        <div className="mt-8 flex flex-col-reverse gap-3 border-border border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
          {step > 0 ? (
            <Button type="button" variant="outline" onClick={() => goTo(step - 1)} data-testid="wizard-back">
              <Trans>Voltar</Trans>
            </Button>
          ) : (
            <span />
          )}

          {isLastStep ? (
            <Button type="button" size="lg" onClick={onOpenConfirm} data-testid="wizard-send">
              <Trans>Enviar para o representante</Trans>
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void onContinue()}
              disabled={isUploading || (step === 2 && isCheckingList)}
              data-testid="wizard-continue"
            >
              <Trans>Continuar</Trans>
            </Button>
          )}
        </div>
      </PageCard>

      <ConfirmSendDialog
        open={isConfirmOpen}
        onOpenChange={setIsConfirmOpen}
        readyCount={readyRows.length}
        isSending={createMutation.isPending}
        error={sendError}
        onConfirm={() => void onSend()}
      />
    </div>
  );
};

type UploadResult = { id: string } | { error: 'INVALID' | 'UNAVAILABLE' };

/** O mesmo upload do editor (`/api/files/upload-pdf`), com a resposta do servidor separada para a mensagem certa. */
const uploadContractPdf = async (file: File): Promise<UploadResult> => {
  const form = new FormData();

  form.append('file', file);

  const response = await fetch(formatPath('/api/files/upload-pdf'), { method: 'POST', body: form });

  if (response.status === 400 || response.status === 413) {
    return { error: 'INVALID' };
  }

  if (!response.ok) {
    return { error: 'UNAVAILABLE' };
  }

  const { id } = (await response.json()) as { id: string };

  return { id };
};

const SaveIndicator = ({ state, onRetry }: { state: SaveState; onRetry: () => void }) => {
  if (state === 'idle') {
    return null;
  }

  return (
    <p
      className={cn(
        'flex items-center gap-1.5 font-semibold text-sm',
        state === 'error' ? 'text-destructive' : 'text-muted-foreground',
      )}
      aria-live="polite"
      data-testid="wizard-save-state"
    >
      {state === 'saving' && (
        <>
          <Loader2Icon className="h-4 w-4 animate-spin" aria-hidden />
          <Trans>Salvando o rascunho…</Trans>
        </>
      )}
      {state === 'saved' && (
        <>
          <CloudIcon className="h-4 w-4" aria-hidden />
          <Trans>Rascunho salvo</Trans>
        </>
      )}
      {state === 'error' && (
        <>
          <CloudOffIcon className="h-4 w-4" aria-hidden />
          <Trans>Não foi possível salvar o rascunho.</Trans>
          <button
            type="button"
            className="rounded-sm font-bold text-brand-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onRetry}
          >
            <Trans>Tentar de novo</Trans>
          </button>
        </>
      )}
    </p>
  );
};

const WizardStepper = ({
  labels,
  step,
  maxStep,
  onSelect,
}: {
  labels: string[];
  step: number;
  maxStep: number;
  onSelect: (step: number) => void;
}) => {
  const { t } = useLingui();

  return (
    <nav aria-label={t`Passos do novo contrato`} className="mt-5">
      <ol className="flex items-center gap-1.5 sm:gap-2" data-testid="wizard-stepper">
        {labels.map((label, index) => {
          const isCurrent = index === step;
          const isDone = index < step;
          const canSelect = index !== step && index <= maxStep;

          return (
            <li key={label} className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
              <button
                type="button"
                disabled={!canSelect}
                onClick={() => onSelect(index)}
                aria-current={isCurrent ? 'step' : undefined}
                aria-label={`${index + 1}. ${label}`}
                className={cn(
                  'flex min-w-0 items-center gap-2 rounded-full py-1.5 pr-3 pl-1.5 text-left font-bold text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  isCurrent ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
                  canSelect && 'hover:bg-accent hover:text-foreground',
                  !canSelect && !isCurrent && 'cursor-default',
                )}
              >
                <span
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-display font-extrabold text-[13px]',
                    isCurrent ? 'bg-white/20' : isDone ? 'bg-success-bg text-success' : 'bg-muted',
                  )}
                  aria-hidden
                >
                  {isDone ? <CheckIcon className="h-4 w-4" /> : index + 1}
                </span>
                <span className={cn('truncate', !isCurrent && 'hidden sm:inline')}>{label}</span>
              </button>

              {index < labels.length - 1 && <span className="h-px min-w-3 flex-1 bg-border" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};
