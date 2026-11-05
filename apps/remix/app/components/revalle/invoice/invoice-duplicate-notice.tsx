import { formatRevalleDateTime } from '@documenso/lib/revalle/date-format';
import { INVOICE_STATUS_LABELS } from '@documenso/lib/revalle/invoice/invoice-filters';
import type { TInvoiceState } from '@documenso/trpc/server/revalle-router/invoice/invoice-state.types';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import { Trans } from '@lingui/react/macro';
import { TriangleAlertIcon } from 'lucide-react';
import { useId } from 'react';

type InvoiceDuplicate = TInvoiceState['duplicates'][number];

export type InvoiceDuplicateNoticeProps = {
  duplicates: InvoiceDuplicate[];
  /**
   * Só o diálogo de envio pede a confirmação (o botão Enviar espera por ela). O cartão do dono, depois do envio, só avisa.
   */
  acknowledgement?: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void };
};

/** "Enviada em 05/11/2026 10:00 por Maria · Pendente": a frase de cada nota parecida, aqui e na página da NF. */
export const InvoiceDuplicateSentence = ({ duplicate }: { duplicate: InvoiceDuplicate }) => {
  const senderName = duplicate.senderName;
  const situation = INVOICE_STATUS_LABELS[duplicate.status];
  const sentAt = duplicate.sentAt ? formatRevalleDateTime(duplicate.sentAt) : null;

  return sentAt ? (
    <Trans>
      Enviada em {sentAt} por {senderName} · {situation}
    </Trans>
  ) : (
    <Trans>
      Enviada por {senderName} · {situation}
    </Trans>
  );
};

/**
 * Fase 8: "Esta nota parece já ter sido enviada". Uma linha por nota parecida, só com data, remetente e situação: quem vê
 * pode não ter acesso à outra nota, então nada de título nem link. No envio, o aviso traz a confirmação que libera o botão.
 */
export const InvoiceDuplicateNotice = ({ duplicates, acknowledgement }: InvoiceDuplicateNoticeProps) => {
  const checkboxId = useId();

  if (duplicates.length === 0) {
    return null;
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
      data-testid="invoice-duplicate-alert"
    >
      <p className="flex items-start gap-2 font-medium">
        <TriangleAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
        <Trans>Esta nota parece já ter sido enviada</Trans>
      </p>

      <ul className="flex flex-col gap-1 pl-6">
        {duplicates.map((duplicate, index) => (
          <li
            key={`${duplicate.sentAt?.toISOString() ?? 'sem-data'}-${index}`}
            className="break-words"
            data-testid="invoice-duplicate-line"
          >
            <InvoiceDuplicateSentence duplicate={duplicate} />
          </li>
        ))}
      </ul>

      {acknowledgement && (
        <label htmlFor={checkboxId} className="flex min-h-11 items-center gap-3 font-medium">
          <Checkbox
            id={checkboxId}
            className="h-6 w-6"
            checked={acknowledgement.checked}
            disabled={acknowledgement.disabled}
            onCheckedChange={(value) => acknowledgement.onChange(value === true)}
            data-testid="invoice-duplicate-ack"
          />
          <Trans>Sei disso e quero enviar mesmo assim</Trans>
        </label>
      )}
    </div>
  );
};
