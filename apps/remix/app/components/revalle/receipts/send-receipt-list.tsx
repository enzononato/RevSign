import { formatSendReceiptHistoryLine } from '@documenso/lib/revalle/receipts/send-receipt';
import { cn } from '@documenso/ui/lib/utils';
import { DownloadIcon, FileCheck2Icon } from 'lucide-react';
import { Link } from 'react-router';

import type { SendStatusReceipt } from './use-send-status';

export type SendReceiptListProps = {
  receipts: SendStatusReceipt[];
  /** Quantos mostrar; o resto fica no histórico completo (`moreHref`). */
  max?: number;
  moreHref?: string;
  className?: string;
};

/**
 * REVALLE: "Comprovante de envio — Fulano (e-mail) — dd/mm/aaaa hh:mm" com o link "Baixar comprovante", do mais novo
 * para o mais antigo.
 */
export const SendReceiptList = ({ receipts, max, moreHref, className }: SendReceiptListProps) => {
  if (receipts.length === 0) {
    return null;
  }

  const visible = max ? receipts.slice(0, max) : receipts;
  const hidden = receipts.length - visible.length;

  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="send-receipt-list">
      <h2 className="font-semibold text-foreground text-xs">Comprovantes de envio</h2>
      <ul className="flex flex-col gap-2">
        {visible.map((receipt) => (
          <li key={receipt.receiptId} className="flex min-w-0 items-start gap-2 text-xs" data-testid="send-receipt">
            <FileCheck2Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="break-words text-muted-foreground leading-5">
                {formatSendReceiptHistoryLine(receipt, new Date(receipt.createdAt))}
              </p>
              <a
                href={receipt.href}
                download
                className="inline-flex min-h-8 items-center gap-1 font-semibold text-brand-text hover:underline"
                data-testid="send-receipt-download"
              >
                <DownloadIcon className="h-3 w-3" aria-hidden />
                Baixar comprovante
              </a>
            </div>
          </li>
        ))}
      </ul>
      {hidden > 0 && moreHref && (
        <Link to={moreHref} className="font-semibold text-brand-text text-xs hover:underline">
          Ver todos os {receipts.length} comprovantes no histórico
        </Link>
      )}
    </div>
  );
};
