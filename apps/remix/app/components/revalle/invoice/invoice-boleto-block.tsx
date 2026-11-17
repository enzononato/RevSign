import { formatInvoiceAmount } from '@documenso/lib/revalle/invoice/invoice-data';
import type { TInvoiceState } from '@documenso/trpc/server/revalle-router/invoice/invoice-state.types';
import { Button } from '@documenso/ui/primitives/button';
import { Spinner } from '@documenso/ui/primitives/spinner';
import { Trans, useLingui } from '@lingui/react/macro';
import { TriangleAlertIcon } from 'lucide-react';
import { useId } from 'react';

import { FILE_HEADER_CLASS } from './invoice-file-block';

type InvoiceDocument = TInvoiceState['documents'][number];

export type InvoiceBoletoBlockProps = {
  document: InvoiceDocument;
  /** A tela desistiu de esperar a leitura (como "Buscando sugestão…" da nota). */
  hasGivenUp: boolean;
  disabled?: boolean;
  /** "Não é boleto": vira documento comum (o remetente pode dizer outro tipo em seguida). */
  onNotBoleto: () => void;
};

const formatCnpj = (cnpj: string) =>
  /^\d{14}$/.test(cnpj) ? cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : cnpj;

const formatDay = (isoDay: string) => isoDay.split('-').reverse().join('/');

/**
 * Fase 9: um boleto do envio no diálogo de envio. `Boleto · boleto.pdf`, o que foi lido (beneficiário, valor e
 * vencimento; só o que existe) e os avisos da conferência com as notas em âmbar. Os avisos não travam o envio.
 */
export const InvoiceBoletoBlock = ({
  document,
  hasGivenUp,
  disabled = false,
  onNotBoleto,
}: InvoiceBoletoBlockProps) => {
  const { t } = useLingui();
  const title = document.title;
  const boleto = document.boleto;
  const data = boleto?.data ?? null;
  const headerId = useId();
  const status = boleto?.status ?? document.suggestionStatus;
  const isReading = status === 'PENDING' && !hasGivenUp;
  // A leitura falhou (ou a tela desistiu de esperar): o que a linha digitável deu continua valendo.
  const hasFailed = status === 'FAILED' || (status === 'PENDING' && hasGivenUp);
  const beneficiary = data?.beneficiaryName ?? (data?.beneficiaryCnpj ? formatCnpj(data.beneficiaryCnpj) : null);
  const dueDate = data?.dueDate ? formatDay(data.dueDate) : null;
  // Texto puro: o nome do beneficiário vem da IA e nunca é interpretado como HTML.
  const readLine = [
    beneficiary,
    data?.amountCents == null ? null : formatInvoiceAmount(data.amountCents),
    dueDate ? t`vence ${dueDate}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  const warnings = boleto?.warnings ?? [];

  return (
    <section
      className="flex min-w-0 flex-col gap-2 rounded-[13px] border p-3"
      aria-labelledby={headerId}
      data-testid="invoice-boleto-block"
      data-envelope-item-id={document.envelopeItemId}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <h4 id={headerId} className={FILE_HEADER_CLASS} data-testid="invoice-file-header">
          <Trans>Boleto · {title}</Trans>
        </h4>
        <Button type="button" variant="link" className="h-11 px-0" disabled={disabled} onClick={onNotBoleto}>
          <Trans>Não é boleto</Trans>
        </Button>
      </div>

      {isReading && (
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <Spinner size="sm" />
          <Trans>Lendo o boleto…</Trans>
        </p>
      )}

      {hasFailed && (
        <p className="text-muted-foreground text-sm" data-testid="invoice-boleto-failed">
          <Trans>Não foi possível ler o boleto.</Trans>
        </p>
      )}

      {readLine && (
        <p className="break-words text-muted-foreground text-sm" data-testid="invoice-boleto-line">
          <Trans>Lido: {readLine}</Trans>
        </p>
      )}

      {warnings.length > 0 && (
        // REVALLE v3: aviso âmbar dos tokens (warning-bg / warning-text), como o de nota duplicada. Só aviso.
        <ul
          className="flex flex-col gap-1.5 rounded-[13px] bg-warning-bg p-3 text-sm"
          data-testid="invoice-boleto-warnings"
        >
          {warnings.map((warning) => (
            <li key={warning.code} className="flex items-start gap-2 font-medium text-warning-text">
              <TriangleAlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
              {/* A mensagem vem pronta do servidor (pt-BR), a mesma da página da NF. */}
              <span className="min-w-0 break-words">{warning.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
