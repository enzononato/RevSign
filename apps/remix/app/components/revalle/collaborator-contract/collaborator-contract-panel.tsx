import { buildCollaboratorContractLine } from '@documenso/lib/revalle/collaborator-contract';
import { formatRevalleDateTime } from '@documenso/lib/revalle/date-format';
import type { TCollaboratorContractStatus } from '@documenso/lib/server-only/revalle/collaborator-contract/status';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { Download, Pause, Play } from 'lucide-react';

import { InvoiceCard, InvoiceRow, InvoiceRows, InvoiceStatePill } from '../invoice/invoice-ui';

export type CollaboratorContractPanelProps = {
  templateEnvelopeId: string;
  status: TCollaboratorContractStatus;
};

const number = (value: number) => new Intl.NumberFormat('pt-BR').format(value);

/**
 * REVALLE (v.21): quadro "Envio para colaboradores" na página do modelo marcado (só admin): os números da planilha e da
 * fila, as falhas com o motivo, a planilha da situação (nome;email;situação;data) e Pausar / Retomar. Só nome, e-mail e
 * situação; nunca CPF. Uma coluna, sem rolagem lateral no celular.
 */
export const CollaboratorContractPanel = ({ templateEnvelopeId, status }: CollaboratorContractPanelProps) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const { mutateAsync: exportCsv, isPending: isExporting } = trpc.revalle.collaboratorContract.exportCsv.useMutation();
  const { mutateAsync: setPaused, isPending: isPausing } = trpc.revalle.collaboratorContract.setPaused.useMutation();

  const { counts } = status;

  const onDownload = async () => {
    try {
      const { csv } = await exportCsv({ templateEnvelopeId });
      const url = window.URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = Object.assign(document.createElement('a'), {
        href: url,
        download: `situacao-colaboradores-${new Date().toISOString().slice(0, 10)}.csv`,
      });

      link.click();
      window.URL.revokeObjectURL(url);
    } catch {
      toast({ title: t`Não foi possível baixar a planilha. Tente de novo.`, variant: 'destructive', duration: 5000 });
    }
  };

  const onTogglePause = async () => {
    try {
      await setPaused({ templateEnvelopeId, paused: !status.paused });
      await utils.revalle.collaboratorContract.getStatus.invalidate({ templateEnvelopeId });
    } catch {
      toast({ title: t`Não foi possível salvar. Tente de novo.`, variant: 'destructive', duration: 5000 });
    }
  };

  const companyLine = buildCollaboratorContractLine({
    representativeName: status.representativeName,
    signedAt: status.representativeSignedAt,
    verificationCode: status.sourceVerificationCode,
  });

  return (
    <InvoiceCard title={<Trans>Envio para colaboradores</Trans>} testId="collaborator-contract-panel">
      <div className="flex flex-wrap gap-2">
        {status.paused ? (
          <InvoiceStatePill tone="warning" testId="collaborator-contract-paused">
            <Trans>Envio pausado</Trans>
          </InvoiceStatePill>
        ) : counts.queued > 0 ? (
          <InvoiceStatePill tone="neutral">
            <Trans>Enviando em lotes ao longo do dia</Trans>
          </InvoiceStatePill>
        ) : null}

        {status.isProcessing && (
          <InvoiceStatePill tone="neutral">
            <Trans>Criando os documentos da planilha</Trans>
          </InvoiceStatePill>
        )}
      </div>

      <p className="break-words text-muted-foreground">
        {companyLine.slice(0, companyLine.length - status.sourceVerificationCode.length)}
        <a
          className="font-semibold text-brand-text underline underline-offset-2"
          href={`/verificar?codigo=${encodeURIComponent(status.sourceVerificationCode)}`}
          target="_blank"
          rel="noreferrer"
        >
          {status.sourceVerificationCode}
        </a>
      </p>

      <InvoiceRows>
        <InvoiceRow label={<Trans>Total da planilha</Trans>} testId="collaborator-count-total">
          {number(counts.totalRows)}
        </InvoiceRow>
        {counts.duplicateRows > 0 && (
          <InvoiceRow label={<Trans>Repetidas (puladas)</Trans>} testId="collaborator-count-duplicates">
            {number(counts.duplicateRows)}
          </InvoiceRow>
        )}
        {counts.notCreated > 0 && (
          <InvoiceRow label={<Trans>Linhas que não viraram documento</Trans>}>{number(counts.notCreated)}</InvoiceRow>
        )}
        <InvoiceRow label={<Trans>Na fila</Trans>} testId="collaborator-count-queued">
          {number(counts.queued)}
        </InvoiceRow>
        <InvoiceRow label={<Trans>Enviados</Trans>} testId="collaborator-count-sent">
          {number(counts.sent)}
        </InvoiceRow>
        <InvoiceRow label={<Trans>Falharam</Trans>} testId="collaborator-count-failed">
          {number(counts.failed)}
        </InvoiceRow>
        <InvoiceRow label={<Trans>Visualizados</Trans>}>{number(counts.opened)}</InvoiceRow>
        <InvoiceRow label={<Trans>Assinados</Trans>} testId="collaborator-count-signed">
          {number(counts.signed)}
        </InvoiceRow>
        <InvoiceRow label={<Trans>Recusados</Trans>}>{number(counts.rejected)}</InvoiceRow>
      </InvoiceRows>

      {status.failures.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2" data-testid="collaborator-contract-failures">
          <h3 className="font-semibold">
            <Trans>Falhas no envio</Trans>
          </h3>
          <ul className="flex min-w-0 flex-col gap-2">
            {status.failures.map((failure) => (
              <li key={failure.id} className="min-w-0 rounded-[13px] bg-muted/60 p-3">
                <p className="break-words font-semibold">{failure.name || failure.email}</p>
                {failure.name && <p className="break-all text-muted-foreground">{failure.email}</p>}
                <p className="break-words">{failure.reason}</p>
                <p className="text-muted-foreground text-xs">{formatRevalleDateTime(failure.date)}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          className="w-full whitespace-normal"
          loading={isExporting}
          onClick={() => void onDownload()}
          data-testid="collaborator-contract-download"
        >
          <Download className="mr-2 h-4 w-4 shrink-0" />
          <Trans>Baixar planilha da situação</Trans>
        </Button>

        <Button
          type="button"
          variant="outline"
          className="w-full whitespace-normal"
          loading={isPausing}
          onClick={() => void onTogglePause()}
          data-testid="collaborator-contract-pause"
        >
          {status.paused ? (
            <>
              <Play className="mr-2 h-4 w-4 shrink-0" />
              <Trans>Retomar envio</Trans>
            </>
          ) : (
            <>
              <Pause className="mr-2 h-4 w-4 shrink-0" />
              <Trans>Pausar envio</Trans>
            </>
          )}
        </Button>
      </div>
    </InvoiceCard>
  );
};
