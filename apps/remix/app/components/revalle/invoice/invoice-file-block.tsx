import { costCenterLabel } from '@documenso/lib/revalle/invoice/cost-centers';
import { formatInvoiceDataLine } from '@documenso/lib/revalle/invoice/invoice-data';
import type { TInvoiceState } from '@documenso/trpc/server/revalle-router/invoice/invoice-state.types';
import { Button } from '@documenso/ui/primitives/button';
import { Spinner } from '@documenso/ui/primitives/spinner';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';

import type { InvoiceAccountOption } from './account-combobox';
import { AccountCombobox } from './account-combobox';
import { CostCenterSelect } from './cost-center-select';
import { InvoiceDuplicateNotice, InvoiceSameEnvelopeNotice } from './invoice-duplicate-notice';
import type { InvoiceFileKindChoice } from './invoice-file-kind-select';
import { InvoiceFileKindSelect } from './invoice-file-kind-select';

type InvoiceDocument = TInvoiceState['documents'][number];

// Nome de arquivo longo sem espaço (ex.: a chave de 44 dígitos de uma NF-e) quebra em qualquer ponto em vez de passar da
// largura do celular.
export const FILE_HEADER_CLASS = 'min-w-0 font-medium text-sm [overflow-wrap:anywhere]';

/** `Nota 2 de 3 · nf-b.pdf` (só o nome do arquivo se, por algum motivo, a nota ainda não tem posição). */
export const InvoiceFileHeader = ({ document, id }: { document: InvoiceDocument; id?: string }) => {
  const title = document.title;

  if (!document.position) {
    return (
      <h4 id={id} className={FILE_HEADER_CLASS} data-testid="invoice-file-header">
        {title}
      </h4>
    );
  }

  const { index, total } = document.position;

  return (
    <h4 id={id} className={FILE_HEADER_CLASS} data-testid="invoice-file-header">
      <Trans>
        Nota {index} de {total} · {title}
      </Trans>
    </h4>
  );
};

export type InvoiceFileBlockProps = {
  document: InvoiceDocument;
  accounts: InvoiceAccountOption[];
  hasNoAccounts: boolean;
  aiAvailable: boolean;
  /** A tela desistiu de esperar a leitura da IA (como no bloco de uma nota). */
  hasGivenUp: boolean;
  disabled?: boolean;
  /** A caixa "Sei disso e quero enviar mesmo assim" desta nota; sem ela, o aviso de duplicada só informa. */
  acknowledgement?: { checked: boolean; onChange: (checked: boolean) => void };
  /** Grava a conta desta nota; `true` quando gravou (a lista fecha). */
  onChoose: (code: string) => Promise<boolean>;
  onChooseCostCenter: (code: string) => void;
  onResuggest: () => void;
  onNotInvoice: () => void;
  /** A linha "No PDF: …" desta nota (o bloco de conta e centro do editor). */
  pdfLine?: ReactNode;
};

/**
 * Fase 9: o bloco de UMA nota no diálogo de envio com várias notas (ou com boleto): o cabeçalho com a posição e o arquivo,
 * os avisos (duplicada de outro envio, com a própria confirmação; a mesma nota deste envio), a sugestão e os dados lidos
 * pela IA, "Sugerir de novo", a conta e o centro de custo dessa nota. O mesmo desenho do bloco de uma nota só.
 */
export const InvoiceFileBlock = ({
  document,
  accounts,
  hasNoAccounts,
  aiAvailable,
  hasGivenUp,
  disabled = false,
  acknowledgement,
  onChoose,
  onChooseCostCenter,
  onResuggest,
  onNotInvoice,
  pdfLine,
}: InvoiceFileBlockProps) => {
  const [isChanging, setIsChanging] = useState(false);
  const headerId = useId();

  const { suggestion, choice } = document;
  const suggestionCode = suggestion?.accountCode;
  const suggestionName = suggestion?.accountName;
  const choiceCode = choice?.code;
  const choiceName = choice?.name ?? '';
  const isPending = document.suggestionStatus === 'PENDING';
  const hasFailed = document.suggestionStatus === 'FAILED' || (isPending && hasGivenUp);
  const canResuggest = aiAvailable && (document.suggestionStatus === 'DONE' || document.suggestionStatus === 'FAILED');
  const invoiceDataLine = formatInvoiceDataLine(document.invoiceData);

  const choose = (code: string) => {
    void onChoose(code).then((saved) => {
      if (saved) {
        setIsChanging(false);
      }
    });
  };

  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-[13px] border p-3"
      aria-labelledby={headerId}
      data-testid="invoice-file-block"
      data-envelope-item-id={document.envelopeItemId}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <InvoiceFileHeader document={document} id={headerId} />
        <Button type="button" variant="link" className="h-11 px-0" disabled={disabled} onClick={onNotInvoice}>
          <Trans>Não é nota fiscal</Trans>
        </Button>
      </div>

      <InvoiceDuplicateNotice duplicates={document.duplicates} acknowledgement={acknowledgement} />

      {document.duplicateInEnvelope && <InvoiceSameEnvelopeNotice index={document.duplicateInEnvelope.index} />}

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
              disabled={disabled}
              onClick={() => choose(suggestion.accountCode)}
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
          disabled={disabled}
          onClick={onResuggest}
        >
          <Trans>Sugerir de novo</Trans>
        </Button>
      )}

      {choice && !isChanging && (
        <div className="flex flex-wrap items-center justify-between gap-x-2 text-sm">
          <p className="min-w-0 break-words" data-testid="invoice-file-choice">
            <Trans>
              Conta escolhida: {choiceCode} · {choiceName}
            </Trans>
          </p>
          {!hasNoAccounts && (
            <Button
              type="button"
              variant="link"
              className="h-11 px-0"
              disabled={disabled}
              onClick={() => setIsChanging(true)}
            >
              <Trans>Trocar</Trans>
            </Button>
          )}
        </div>
      )}

      {(!choice || isChanging) && !hasNoAccounts && (
        <AccountCombobox accounts={accounts} value={choiceCode ?? null} disabled={disabled} onSelect={choose} />
      )}

      {!choice && !hasNoAccounts && (
        <p className="text-sm text-warning-text">
          <Trans>Escolha a conta contábil.</Trans>
        </p>
      )}

      <CostCenterSelect value={document.costCenter?.code ?? null} disabled={disabled} onSelect={onChooseCostCenter} />

      {!document.costCenter && (
        <p className="text-sm text-warning-text">
          <Trans>Escolha o centro de custo.</Trans>
        </p>
      )}

      {pdfLine}
    </section>
  );
};

/**
 * Fase 9: a nota só para leitura (nova versão: a conta e o centro estão travados). Cabeçalho, conta e centro; `children`
 * logo abaixo (o aviso de duplicada dessa nota, quando o rascunho pode ser enviado por aqui).
 */
export const InvoiceFileSummary = ({ document, children }: { document: InvoiceDocument; children?: ReactNode }) => {
  const choice = document.choice;
  const choiceLabel = choice?.name ? `${choice.code} – ${choice.name}` : (choice?.code ?? '-');

  return (
    <div
      className="flex min-w-0 flex-col gap-1 border-t pt-2 first:border-t-0 first:pt-0"
      data-testid="invoice-file-summary"
      data-envelope-item-id={document.envelopeItemId}
    >
      <InvoiceFileHeader document={document} />
      <p className="break-words text-sm">{choiceLabel}</p>
      {document.costCenter && (
        <p className="text-sm">
          <Trans>Centro de custo: {costCenterLabel(document.costCenter.code)}</Trans>
        </p>
      )}
      {children}
    </div>
  );
};

/** Fase 9: arquivo sem texto (UNKNOWN): o remetente diz o tipo antes de enviar. */
export const InvoiceUnknownFileBlock = ({
  document,
  disabled = false,
  onSelect,
}: {
  document: InvoiceDocument;
  disabled?: boolean;
  onSelect: (kind: InvoiceFileKindChoice) => void;
}) => {
  const title = document.title;
  const headerId = useId();

  return (
    <section
      className="flex min-w-0 flex-col gap-2 rounded-[13px] border p-3"
      aria-labelledby={headerId}
      data-testid="invoice-unknown-file"
      data-envelope-item-id={document.envelopeItemId}
    >
      <h4 id={headerId} className={FILE_HEADER_CLASS} data-testid="invoice-file-header">
        {title}
      </h4>
      <InvoiceFileKindSelect
        labelledBy={headerId}
        value={null}
        disabled={disabled}
        onSelect={onSelect}
        label={<Trans>Este arquivo é:</Trans>}
        testId="invoice-file-kind"
      />
      <p className="text-sm text-warning-text">
        <Trans>Responda para enviar</Trans>
      </p>
    </section>
  );
};

/**
 * Fase 9: documento comum (contrato, relatório) no meio das notas: uma linha `contrato.pdf · documento comum` e o mesmo
 * seletor, para o remetente corrigir o tipo (não vai para a IA enquanto for "outro").
 */
export const InvoiceOtherFileRow = ({
  document,
  disabled = false,
  onSelect,
}: {
  document: InvoiceDocument;
  disabled?: boolean;
  onSelect: (kind: InvoiceFileKindChoice) => void;
}) => {
  const title = document.title;
  const headerId = useId();

  return (
    <section
      className="flex min-w-0 flex-col gap-2 rounded-[13px] border border-dashed p-3"
      aria-labelledby={headerId}
      data-testid="invoice-other-file"
      data-envelope-item-id={document.envelopeItemId}
    >
      <p
        id={headerId}
        className="min-w-0 text-muted-foreground text-sm [overflow-wrap:anywhere]"
        data-testid="invoice-file-header"
      >
        <Trans>{title} · documento comum</Trans>
      </p>
      <InvoiceFileKindSelect
        value="OTHER"
        disabled={disabled}
        onSelect={onSelect}
        labelledBy={headerId}
        testId="invoice-file-kind"
      />
    </section>
  );
};
