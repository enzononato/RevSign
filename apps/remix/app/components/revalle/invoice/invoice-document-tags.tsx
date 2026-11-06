import { costCenterName } from '@documenso/lib/revalle/invoice/cost-centers';
import type { TInvoiceDocumentTagsResponse } from '@documenso/trpc/server/revalle-router/invoice/document-tags.types';

export type InvoiceDocumentTagsProps = {
  tags?: TInvoiceDocumentTagsResponse[number];
};

/** Conta e centro de custo de uma NF na lista de Documentos, no mesmo desenho das etiquetas da lista de NFs. */
export const InvoiceDocumentTags = ({ tags }: InvoiceDocumentTagsProps) => {
  if (!tags || (!tags.account && !tags.costCenterCode)) {
    return null;
  }

  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5" data-testid="document-row-invoice-tags">
      {tags.account && (
        <Tag code={tags.account.code} label="Conta contábil">
          {tags.account.name}
        </Tag>
      )}
      {tags.costCenterCode && (
        <Tag code={tags.costCenterCode} label="Centro de custo">
          {costCenterName(tags.costCenterCode)}
        </Tag>
      )}
    </div>
  );
};

const Tag = ({ code, label, children }: { code: string; label: string; children?: string | null }) => (
  <span
    className="inline-flex h-[26px] max-w-[14rem] items-center gap-1.5 rounded-full bg-muted px-2.5 font-semibold text-[13px]"
    title={children ? `${label}: ${code} – ${children}` : `${label}: ${code}`}
  >
    <em className="shrink-0 font-display font-extrabold text-[12.5px] text-brand-text not-italic">{code}</em>
    {children && <span className="min-w-0 truncate">{children}</span>}
  </span>
);
