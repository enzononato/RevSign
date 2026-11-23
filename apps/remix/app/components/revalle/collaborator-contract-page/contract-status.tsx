import {
  REVALLE_COLLABORATOR_STATUS_LABELS,
  type RevalleCollaboratorDocStatus,
} from '@documenso/lib/revalle/collaborator-contract';
import { formatRevalleDateTime } from '@documenso/lib/revalle/date-format';
import { trpc } from '@documenso/trpc/react';
import type { ZGetCollaboratorContractResponseSchema } from '@documenso/trpc/server/revalle-router/collaborator-contract/page/get.types';
import type { ZFindCollaboratorContractRowsResponseSchema } from '@documenso/trpc/server/revalle-router/collaborator-contract/page/rows.types';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@documenso/ui/primitives/dialog';
import { Input } from '@documenso/ui/primitives/input';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  ArrowLeftIcon,
  CheckIcon,
  DownloadIcon,
  MailIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { z } from 'zod';

import {
  CONTRACTS_PATH,
  ContractStatusPill,
  DocStatusPill,
  downloadText,
  EmptyState,
  errorMessage,
  formatCount,
  formatShortDateTime,
  PageCard,
  slugify,
} from './contract-ui';

// REVALLE (v.22): a página do contrato (acompanhamento): representante → envio → assinaturas, a barra de progresso,
// pausar/retomar, baixar a situação, a busca, os filtros e a tabela (cartões no celular). Atualiza sozinha a cada 30 s
// enquanto a aba está aberta (o react-query não busca com a aba escondida).

const REFRESH_MS = 30_000;
const PER_PAGE = 50;

type Filter = 'ALL' | RevalleCollaboratorDocStatus;

const FILTERS: Filter[] = ['ALL', 'QUEUED', 'SENT', 'OPENED', 'SIGNED', 'REJECTED', 'FAILED'];

type ContractData = z.infer<typeof ZGetCollaboratorContractResponseSchema>;
type Row = z.infer<typeof ZFindCollaboratorContractRowsResponseSchema>['rows'][number];

const RESENDABLE: RevalleCollaboratorDocStatus[] = ['SENT', 'OPENED'];

export const ContractStatus = ({ contractId }: { contractId: string }) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const location = useLocation();

  // Vindo do assistente com o aviso do `create`: o convite ao representante não saiu.
  const [sendFailed, setSendFailed] = useState(
    () => (location.state as { representativeNotSent?: boolean } | null)?.representativeNotSent === true,
  );

  const [filter, setFilter] = useState<Filter>('ALL');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pauseDialog, setPauseDialog] = useState<'pause' | 'resume' | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);

  const refresh = { refetchInterval: REFRESH_MS, refetchIntervalInBackground: false } as const;

  const contractQuery = trpc.revalle.collaboratorContract.page.get.useQuery({ contractId }, { ...refresh, retry: 1 });
  const rowsQuery = trpc.revalle.collaboratorContract.page.rows.useQuery(
    { contractId, filter, search: search || undefined, page, perPage: PER_PAGE },
    { ...refresh, placeholderData: (previous) => previous },
  );

  const utils = trpc.useUtils();
  const noInvalidate = { meta: { doNotInvalidateQueryOnMutation: true } };

  const setPaused = trpc.revalle.collaboratorContract.page.setPaused.useMutation(noInvalidate);
  const resendRepresentative = trpc.revalle.collaboratorContract.page.resendRepresentative.useMutation(noInvalidate);
  const resend = trpc.revalle.collaboratorContract.page.resend.useMutation(noInvalidate);
  const exportCsv = trpc.revalle.collaboratorContract.page.exportCsv.useMutation(noInvalidate);

  // Busca depois de uma pausa na digitação.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 400);

    return () => clearTimeout(timer);
  }, [searchInput]);

  const reload = async () => {
    await Promise.all([
      utils.revalle.collaboratorContract.page.get.invalidate({ contractId }),
      utils.revalle.collaboratorContract.page.rows.invalidate({ contractId }),
    ]);
  };

  const data = contractQuery.data;

  if (!data) {
    return (
      <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 md:px-8">
        <EmptyState testId="contract-status-loading">
          {contractQuery.isError ? (
            <>
              <p>{errorMessage(contractQuery.error, t`Não foi possível carregar o contrato. Tente de novo.`)}</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="outline" onClick={() => void contractQuery.refetch()}>
                  <Trans>Tentar de novo</Trans>
                </Button>
                <Button asChild variant="ghost">
                  <Link to={CONTRACTS_PATH}>
                    <Trans>Voltar para a lista</Trans>
                  </Link>
                </Button>
              </div>
            </>
          ) : (
            <p>
              <Trans>Carregando…</Trans>
            </p>
          )}
        </EmptyState>
      </div>
    );
  }

  const { contract, counts, representative } = data;

  const isLegacy = contract.isLegacy;
  const canPause =
    !isLegacy &&
    (contract.status === 'AWAITING_REPRESENTATIVE' || contract.status === 'SENDING' || contract.status === 'PAUSED');
  const isPaused = contract.paused || contract.status === 'PAUSED';
  // O representante ainda não recebeu o convite: o documento dele ficou como rascunho (o envio falhou). Vale o que o
  // servidor diz; o aviso do assistente só cobre o instante em que o documento ainda não aparece.
  const representativeNotReached = representative ? representative.status === 'NOT_SENT' : sendFailed;

  const onConfirmPause = async () => {
    const paused = pauseDialog === 'pause';

    try {
      await setPaused.mutateAsync({ contractId, paused });
      setPauseDialog(null);
      toast({ title: paused ? t`Envio pausado` : t`Envio retomado`, duration: 5000 });
      await reload();
    } catch (err) {
      toast({
        title: t`Não foi possível mudar o envio`,
        description: errorMessage(err, t`Tente de novo.`),
        variant: 'destructive',
      });
    }
  };

  const onResendRepresentative = async () => {
    try {
      await resendRepresentative.mutateAsync({ contractId });
      setSendFailed(false);
      toast({ title: t`Contrato reenviado para o representante`, duration: 5000 });
      await reload();
    } catch (err) {
      toast({
        title: t`Não foi possível reenviar`,
        description: errorMessage(err, t`Tente de novo.`),
        variant: 'destructive',
      });
    }
  };

  const onResend = async (row: Row) => {
    setResendingId(row.queueId);

    try {
      await resend.mutateAsync({ contractId, queueId: row.queueId });
      toast({ title: t`Convite reenviado`, description: row.email, duration: 5000 });
    } catch (err) {
      toast({
        title: t`Não foi possível reenviar`,
        description: errorMessage(err, t`Tente de novo.`),
        variant: 'destructive',
      });
    } finally {
      setResendingId(null);
    }
  };

  const onDownload = async () => {
    try {
      const result = await exportCsv.mutateAsync({ contractId });
      const today = new Date().toISOString().slice(0, 10);

      downloadText(result.csv, `situacao-${slugify(contract.title)}-${today}.csv`);
    } catch (err) {
      toast({
        title: t`Não foi possível baixar a situação`,
        description: errorMessage(err, t`Tente de novo.`),
        variant: 'destructive',
      });
    }
  };

  const rowsData = rowsQuery.data;
  const totalPages = rowsData ? Math.max(1, Math.ceil(rowsData.total / PER_PAGE)) : 1;
  const filterCounts: Record<Filter, number> = {
    ALL: counts.queued + counts.sent + counts.viewed + counts.signed + counts.rejected + counts.failed,
    QUEUED: counts.queued,
    SENT: counts.sent,
    OPENED: counts.viewed,
    SIGNED: counts.signed,
    REJECTED: counts.rejected,
    FAILED: counts.failed,
  };
  const filterLabel = (value: Filter) => (value === 'ALL' ? t`Todos` : REVALLE_COLLABORATOR_STATUS_LABELS[value]);
  const hasDocuments = filterCounts.ALL > 0;

  return (
    <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 md:px-8" data-testid="contract-status-page">
      <Link
        to={CONTRACTS_PATH}
        className="inline-flex items-center gap-1.5 rounded-sm font-bold text-brand-text text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeftIcon className="h-4 w-4" aria-hidden />
        <Trans>Contratos para colaboradores</Trans>
      </Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1
            className="break-words font-black font-display text-[28px] leading-[1.1] tracking-[-0.03em] md:text-[34px]"
            data-testid="contract-title-heading"
          >
            {contract.title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm">
            <ContractStatusPill status={contract.status} />
            <span>
              <Trans>Criado em {formatRevalleDateTime(contract.createdAt)}</Trans>
            </span>
            {isLegacy && (
              <span>
                <Trans>Contrato da versão anterior (por modelo): só a situação.</Trans>
              </span>
            )}
          </div>
        </div>

        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          {canPause && (
            <Button
              variant="outline"
              className="flex-1 sm:flex-none"
              onClick={() => setPauseDialog(isPaused ? 'resume' : 'pause')}
              data-testid={isPaused ? 'contract-resume' : 'contract-pause'}
            >
              {isPaused ? (
                <>
                  <PlayIcon className="mr-2 h-4 w-4" aria-hidden />
                  <Trans>Retomar envio</Trans>
                </>
              ) : (
                <>
                  <PauseIcon className="mr-2 h-4 w-4" aria-hidden />
                  <Trans>Pausar envio</Trans>
                </>
              )}
            </Button>
          )}
          <Button
            variant="outline"
            className="flex-1 sm:flex-none"
            loading={exportCsv.isPending}
            disabled={!hasDocuments}
            onClick={() => void onDownload()}
            data-testid="contract-download"
          >
            {!exportCsv.isPending && <DownloadIcon className="mr-2 h-4 w-4" aria-hidden />}
            <Trans>Baixar situação</Trans>
          </Button>
        </div>
      </div>

      <StageTrack data={data} />

      {contract.status === 'REJECTED_BY_REPRESENTATIVE' && (
        <Notice tone="danger" testId="contract-rejected">
          <Trans>O representante recusou o contrato. Nada foi enviado aos colaboradores.</Trans>
        </Notice>
      )}

      {contract.status === 'AWAITING_REPRESENTATIVE' && (
        <Notice
          tone="warning"
          testId={representativeNotReached ? 'contract-representative-not-sent' : 'contract-awaiting'}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p>
              {representativeNotReached ? (
                <Trans>Não foi possível enviar para o representante. Tente de novo.</Trans>
              ) : (
                <Trans>
                  Aguardando o representante ({representative?.email ?? contract.representativeEmail ?? '—'}). Assim que
                  ele assinar, o envio para os colaboradores começa sozinho.
                </Trans>
              )}
              {contract.paused && (
                <>
                  {' '}
                  <Trans>O envio está pausado: depois da assinatura, ele só começa quando você retomar.</Trans>
                </>
              )}
            </p>
            <Button
              variant="outline"
              className="shrink-0 bg-card"
              loading={resendRepresentative.isPending}
              onClick={() => void onResendRepresentative()}
              data-testid="contract-resend-representative"
            >
              {!resendRepresentative.isPending && <MailIcon className="mr-2 h-4 w-4" aria-hidden />}
              <Trans>Reenviar para o representante</Trans>
            </Button>
          </div>
        </Notice>
      )}

      {counts.notCreated > 0 && (
        <Notice tone="danger" testId="contract-not-created">
          {t`${plural(counts.notCreated, {
            one: '# colaborador não pôde receber o documento',
            other: '# colaboradores não puderam receber o documento',
          })}`}
          <span className="block font-normal">
            <Trans>Erro ao criar o documento: confira a linha na planilha e envie de novo num contrato novo.</Trans>
          </span>
        </Notice>
      )}

      {contract.isBuilding && contract.status !== 'AWAITING_REPRESENTATIVE' && (
        <Notice tone="neutral" testId="contract-building">
          <Trans>
            O representante assinou. Os documentos dos colaboradores estão sendo criados; isso leva alguns minutos.
          </Trans>
        </Notice>
      )}

      {contract.status === 'PAUSED' && (
        <Notice tone="neutral" testId="contract-paused">
          <Trans>O envio está pausado. Ninguém mais recebe o convite até você retomar.</Trans>
        </Notice>
      )}

      <section className="mt-6" aria-labelledby="collaborators-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="collaborators-heading" className="font-display font-extrabold text-[20px]">
            <Trans>Colaboradores</Trans>
          </h2>
          <p className="flex items-center gap-1.5 text-muted-foreground text-xs" data-testid="contract-refresh-note">
            <RefreshCwIcon className={cn('h-3.5 w-3.5', contractQuery.isFetching && 'animate-spin')} aria-hidden />
            <Trans>Atualiza sozinha a cada 30 segundos.</Trans>
          </p>
        </div>

        <div className="mt-3 flex flex-col gap-3">
          <div className="relative">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-3.5 h-[17px] w-[17px] -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              className="pl-10"
              aria-label={t`Buscar por nome, e-mail ou CPF`}
              placeholder={t`Buscar por nome, e-mail ou CPF completo`}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              data-testid="contract-search"
            />
          </div>

          <fieldset className="flex min-w-0 flex-wrap gap-2">
            <legend className="sr-only">
              <Trans>Filtrar por situação</Trans>
            </legend>
            {FILTERS.map((value) => {
              const isActive = filter === value;

              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => {
                    setFilter(value);
                    setPage(1);
                  }}
                  className={cn(
                    'inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 font-bold text-[13.5px] transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-card text-foreground shadow-card hover:bg-accent',
                  )}
                  data-testid={`contract-filter-${value}`}
                >
                  {filterLabel(value)}
                  <span className={cn('tabular-nums', isActive ? 'opacity-80' : 'text-muted-foreground')}>
                    {formatCount(filterCounts[value])}
                  </span>
                </button>
              );
            })}
          </fieldset>
        </div>

        <div className={cn('mt-4', rowsQuery.isFetching && !rowsQuery.isPending && 'opacity-80')}>
          {rowsData && rowsData.rows.length > 0 ? (
            <>
              <RowsTable rows={rowsData.rows} resendingId={resendingId} onResend={onResend} canResend={!isLegacy} />
              <RowsCards rows={rowsData.rows} resendingId={resendingId} onResend={onResend} canResend={!isLegacy} />
            </>
          ) : rowsData ? (
            <EmptyState testId="contract-rows-empty">
              <p>
                {!hasDocuments ? (
                  contract.status === 'REJECTED_BY_REPRESENTATIVE' ? (
                    <Trans>Nenhum documento foi criado.</Trans>
                  ) : (
                    <Trans>
                      A lista aparece aqui depois que o representante assinar e os documentos forem criados.
                    </Trans>
                  )
                ) : search ? (
                  <Trans>Ninguém encontrado com essa busca.</Trans>
                ) : (
                  <Trans>Ninguém nesta situação.</Trans>
                )}
              </p>
              {(search || filter !== 'ALL') && hasDocuments && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearchInput('');
                    setSearch('');
                    setFilter('ALL');
                    setPage(1);
                  }}
                >
                  <Trans>Limpar busca e filtro</Trans>
                </Button>
              )}
            </EmptyState>
          ) : (
            <EmptyState>
              <p>
                {rowsQuery.isError ? (
                  <Trans>Não foi possível carregar a lista. Tente de novo.</Trans>
                ) : (
                  <Trans>Carregando…</Trans>
                )}
              </p>
            </EmptyState>
          )}
        </div>

        {rowsData && totalPages > 1 && (
          <nav className="mt-5 flex flex-wrap items-center justify-between gap-3" aria-label={t`Paginação`}>
            <p className="font-semibold text-muted-foreground text-sm">
              <Trans>
                Página {page} de {totalPages}
              </Trans>
            </p>
            <div className="flex gap-2">
              <Button variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                <Trans>Anterior</Trans>
              </Button>
              <Button variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                <Trans>Próxima</Trans>
              </Button>
            </div>
          </nav>
        )}
      </section>

      <Dialog
        open={pauseDialog !== null}
        onOpenChange={(open) => !open && !setPaused.isPending && setPauseDialog(null)}
      >
        <DialogContent data-testid="contract-pause-dialog">
          <DialogHeader>
            <DialogTitle>
              {pauseDialog === 'pause' ? <Trans>Pausar o envio?</Trans> : <Trans>Retomar o envio?</Trans>}
            </DialogTitle>
            <DialogDescription>
              {pauseDialog === 'pause' ? (
                <Trans>
                  Quem ainda está na fila não recebe o convite até você retomar. Quem já recebeu continua podendo
                  assinar.
                </Trans>
              ) : (
                <Trans>Os convites que faltam voltam a sair, no ritmo de sempre.</Trans>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={setPaused.isPending} onClick={() => setPauseDialog(null)}>
              <Trans>Cancelar</Trans>
            </Button>
            <Button
              loading={setPaused.isPending}
              onClick={() => void onConfirmPause()}
              data-testid="contract-pause-confirm"
            >
              {pauseDialog === 'pause' ? <Trans>Pausar envio</Trans> : <Trans>Retomar envio</Trans>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

/** Representante → Envio → Assinaturas, e a barra de quantos já assinaram. */
const StageTrack = ({ data }: { data: ContractData }) => {
  const { contract, counts, representative } = data;

  const total = contract.total;
  const sent = counts.sent + counts.viewed + counts.signed + counts.rejected;
  const percent = total > 0 ? Math.round((counts.signed / total) * 100) : 0;
  const repStatus = representative?.status ?? 'NOT_SENT';
  const isRejected = contract.status === 'REJECTED_BY_REPRESENTATIVE' || repStatus === 'REJECTED';
  const repSigned = repStatus === 'SIGNED' || (contract.isLegacy && !isRejected);
  const totalLabel = formatCount(total);
  const sentLabel = formatCount(sent);
  const signedLabel = formatCount(counts.signed);

  return (
    <PageCard className="mt-5" testId="contract-stages">
      <ol className="grid gap-3 md:grid-cols-3 md:gap-0">
        <Stage
          index={1}
          state={isRejected ? 'rejected' : repSigned ? 'done' : 'current'}
          title={<Trans>Representante</Trans>}
          testId="stage-representative"
        >
          {isRejected ? (
            <Trans>recusou</Trans>
          ) : repSigned && representative?.signedAt ? (
            <Trans>assinou {formatShortDateTime(representative.signedAt)}</Trans>
          ) : repSigned ? (
            <Trans>assinou</Trans>
          ) : repStatus === 'OPENED' ? (
            <Trans>abriu, ainda não assinou</Trans>
          ) : repStatus === 'NOT_SENT' ? (
            <Trans>ainda não recebeu</Trans>
          ) : (
            <Trans>aguardando a assinatura</Trans>
          )}
          {representative?.name && <span className="block truncate">{representative.name}</span>}
        </Stage>

        <Stage
          index={2}
          state={
            !repSigned || isRejected
              ? 'todo'
              : total > 0 && counts.queued === 0 && !contract.isBuilding
                ? 'done'
                : 'current'
          }
          title={<Trans>Envio</Trans>}
          testId="stage-sending"
        >
          <Trans>
            {sentLabel}/{totalLabel} enviados
          </Trans>
          {counts.failed > 0 && (
            <span className="block text-destructive">
              <Trans>{formatCount(counts.failed)} falharam</Trans>
            </span>
          )}
          {counts.notCreated > 0 && (
            <span className="block text-destructive">
              <Trans>{formatCount(counts.notCreated)} sem documento</Trans>
            </span>
          )}
        </Stage>

        <Stage
          index={3}
          state={contract.status === 'COMPLETED' ? 'done' : !repSigned || isRejected ? 'todo' : 'current'}
          title={<Trans>Assinaturas</Trans>}
          testId="stage-signatures"
        >
          {signedLabel}
          {counts.rejected > 0 && (
            <span className="block">
              <Trans>{formatCount(counts.rejected)} recusaram</Trans>
            </span>
          )}
        </Stage>
      </ol>

      <div className="mt-5">
        <div
          className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={`${signedLabel} / ${totalLabel}`}
        >
          <div className="h-full rounded-full bg-success transition-all" style={{ width: `${percent}%` }} />
        </div>
        <p className="mt-2 font-semibold text-sm" data-testid="contract-progress">
          <Trans>
            {signedLabel} de {totalLabel} assinaram
          </Trans>
        </p>
      </div>
    </PageCard>
  );
};

const Stage = ({
  index,
  state,
  title,
  children,
  testId,
}: {
  index: number;
  state: 'done' | 'current' | 'todo' | 'rejected';
  title: ReactNode;
  children: ReactNode;
  testId: string;
}) => (
  <li
    className={cn(
      'flex min-w-0 items-start gap-3 md:border-border md:border-l md:px-5 md:first:border-l-0 md:first:pl-0',
      state === 'todo' && 'opacity-60',
    )}
    data-testid={testId}
    data-state={state}
  >
    <span
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-display font-extrabold text-[13px]',
        state === 'done' && 'bg-success-bg text-success',
        state === 'current' && 'bg-primary text-primary-foreground',
        state === 'todo' && 'bg-muted text-muted-foreground',
        state === 'rejected' && 'bg-danger-bg text-destructive',
      )}
      aria-hidden
    >
      {state === 'done' ? (
        <CheckIcon className="h-4 w-4" />
      ) : state === 'rejected' ? (
        <XIcon className="h-4 w-4" />
      ) : (
        index
      )}
    </span>
    <div className="min-w-0">
      <p className="font-bold text-sm">{title}</p>
      <div className="text-muted-foreground text-sm">{children}</div>
    </div>
  </li>
);

const Notice = ({
  tone,
  children,
  testId,
}: {
  tone: 'warning' | 'danger' | 'neutral';
  children: ReactNode;
  testId?: string;
}) => (
  <div
    className={cn(
      'mt-4 rounded-card p-4 font-semibold text-sm',
      tone === 'warning' && 'bg-warning-bg text-warning-text',
      tone === 'danger' && 'bg-danger-bg text-destructive',
      tone === 'neutral' && 'bg-muted text-foreground',
    )}
    role="status"
    data-testid={testId}
  >
    {children}
  </div>
);

type RowsProps = {
  rows: Row[];
  resendingId: string | null;
  onResend: (row: Row) => void;
  canResend: boolean;
};

const ResendButton = ({ row, resendingId, onResend, canResend }: Omit<RowsProps, 'rows'> & { row: Row }) => {
  const { t } = useLingui();

  if (!canResend || !RESENDABLE.includes(row.status)) {
    return null;
  }

  return (
    <Button
      variant="outline"
      size="sm"
      loading={resendingId === row.queueId}
      disabled={resendingId !== null && resendingId !== row.queueId}
      aria-label={t`Reenviar para ${row.name || row.email}`}
      onClick={() => onResend(row)}
      data-testid="row-resend"
    >
      <Trans>Reenviar</Trans>
    </Button>
  );
};

const RowsTable = (props: RowsProps) => (
  <div className="hidden overflow-hidden rounded-card bg-card shadow-card md:block" data-testid="contract-rows-table">
    <table className="w-full table-fixed border-collapse text-left text-sm">
      <thead>
        <tr className="border-border border-b text-muted-foreground">
          <th scope="col" className="w-[24%] px-4 py-3 font-semibold">
            <Trans>Nome</Trans>
          </th>
          <th scope="col" className="w-[28%] px-4 py-3 font-semibold">
            <Trans>E-mail</Trans>
          </th>
          <th scope="col" className="w-[14%] px-4 py-3 font-semibold">
            CPF
          </th>
          <th scope="col" className="w-[16%] px-4 py-3 font-semibold">
            <Trans>Situação</Trans>
          </th>
          <th scope="col" className="w-[12%] px-4 py-3 font-semibold">
            <Trans>Data</Trans>
          </th>
          <th scope="col" className="w-[110px] px-4 py-3">
            <span className="sr-only">
              <Trans>Ações</Trans>
            </span>
          </th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => (
          <tr key={row.queueId} className="border-border border-b align-top last:border-0" data-testid="contract-row">
            <td className="break-words px-4 py-3 font-semibold">{row.name || '—'}</td>
            <td className="break-all px-4 py-3">{row.email}</td>
            <td className="whitespace-nowrap px-4 py-3 tabular-nums">{row.cpfMasked ?? '—'}</td>
            <td className="px-4 py-3">
              <DocStatusPill status={row.status} />
              {row.failureReason && <p className="mt-1 text-destructive text-xs">{row.failureReason}</p>}
            </td>
            <td className="px-4 py-3 text-muted-foreground tabular-nums">
              {row.at ? formatRevalleDateTime(row.at) : '—'}
            </td>
            <td className="px-4 py-3 text-right">
              <ResendButton row={row} {...props} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const RowsCards = (props: RowsProps) => (
  <ul className="flex flex-col gap-2.5 md:hidden" data-testid="contract-rows-cards">
    {props.rows.map((row) => (
      <li key={row.queueId} className="min-w-0 rounded-card bg-card p-4 shadow-card" data-testid="contract-row-card">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 break-words font-bold">{row.name || '—'}</p>
          <DocStatusPill status={row.status} className="shrink-0" />
        </div>
        <p className="mt-1 break-all text-sm">{row.email}</p>
        <p className="mt-0.5 text-muted-foreground text-sm tabular-nums">
          {row.cpfMasked ? `CPF ${row.cpfMasked}` : null}
          {row.cpfMasked && row.at ? ' · ' : null}
          {row.at ? formatRevalleDateTime(row.at) : null}
        </p>
        {row.failureReason && <p className="mt-1 text-destructive text-sm">{row.failureReason}</p>}
        <div className="mt-3 empty:hidden">
          <ResendButton row={row} {...props} />
        </div>
      </li>
    ))}
  </ul>
);
