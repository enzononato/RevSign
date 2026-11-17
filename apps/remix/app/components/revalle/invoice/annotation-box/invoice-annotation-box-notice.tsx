import type { TInvoiceState } from '@documenso/trpc/server/revalle-router/invoice/invoice-state.types';
import { Trans } from '@lingui/react/macro';
import { AlertTriangleIcon } from 'lucide-react';

type InvoicePdfAnnotationLineProps = {
  state: Pick<TInvoiceState, 'autoAnnotation' | 'annotationBoxes' | 'documents'>;
  /** A nota; nulo quando o estado não diz qual arquivo é (vale o bloco de qualquer arquivo que seja nota). */
  envelopeItemId: string | null;
  /** `false` no editor antigo, que não tem o bloco: sem bloco, a linha não aparece. */
  hasAnnotationBox: boolean;
};

/** "No PDF: …": o que a selagem vai escrever na nota (conta e centro no bloco, acima da assinatura ou nada). */
export const InvoicePdfAnnotationLine = ({
  state,
  envelopeItemId,
  hasAnnotationBox,
}: InvoicePdfAnnotationLineProps) => {
  const className = 'min-w-0 break-words text-muted-foreground text-xs';

  if (state.autoAnnotation) {
    return (
      <p className={className} data-testid="invoice-pdf-annotation-line">
        <Trans>No PDF: conta e centro acima da assinatura (envio de antes da atualização).</Trans>
      </p>
    );
  }

  // Só o bloco de uma nota: o bloco num contrato tem o aviso em âmbar, nunca "na página N".
  const box = state.annotationBoxes.find((candidate) =>
    envelopeItemId
      ? candidate.envelopeItemId === envelopeItemId
      : state.documents.some((doc) => doc.envelopeItemId === candidate.envelopeItemId && doc.kind === 'NF'),
  );

  if (box) {
    const page = box.page;

    return (
      <p className={className} data-testid="invoice-pdf-annotation-line">
        <Trans>No PDF: conta e centro na página {page}.</Trans>
      </p>
    );
  }

  if (!hasAnnotationBox) {
    return null;
  }

  return (
    <p className={className} data-testid="invoice-pdf-annotation-line">
      <Trans>No PDF: sem conta e centro (opcional — coloque o bloco no passo Adicionar campos).</Trans>
    </p>
  );
};

/**
 * Aviso em âmbar para cada bloco num arquivo que não é nota (contrato, boleto): a selagem não escreve nada ali. Só
 * avisa, não trava o envio.
 */
export const InvoiceAnnotationBoxWarnings = ({ state }: { state: TInvoiceState }) => {
  if (state.autoAnnotation) {
    return null;
  }

  const files = state.annotationBoxes.flatMap((box) => {
    const document = state.documents.find((doc) => doc.envelopeItemId === box.envelopeItemId);

    return document && document.kind !== 'NF' ? [{ id: document.envelopeItemId, title: document.title }] : [];
  });

  if (files.length === 0) {
    return null;
  }

  return (
    <ul
      className="flex min-w-0 flex-col gap-1.5 rounded-[13px] bg-warning-bg p-3 text-sm"
      data-testid="invoice-annotation-box-warnings"
    >
      {files.map(({ id, title }) => (
        <li key={id} className="flex items-start gap-2 font-medium text-warning-text">
          <AlertTriangleIcon className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <Trans>O bloco de conta e centro em {title} não será impresso: só sai em nota fiscal.</Trans>
          </span>
        </li>
      ))}
    </ul>
  );
};
