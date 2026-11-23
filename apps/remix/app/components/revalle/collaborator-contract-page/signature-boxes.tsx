import {
  clampSignatureRect,
  SIGNATURE_RECT_MIN_HEIGHT,
  SIGNATURE_RECT_MIN_WIDTH,
  type SignatureRect,
} from '@documenso/lib/revalle/collaborator-contract-rect';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { type KeyboardEvent, type PointerEvent, useId, useRef } from 'react';

import { PdfPageView } from './contract-pdf';

// REVALLE (v.22): os dois quadros de assinatura sobre a prévia do contrato. Arrastar move, o canto de baixo à direita
// muda o tamanho, e cada quadro fica sempre dentro da página (mesma regra do servidor, `clampSignatureRect`).

export type BoxKind = 'representative' | 'collaborator';

export type ContractBoxes = Record<BoxKind, SignatureRect>;

export const BOX_KINDS: BoxKind[] = ['representative', 'collaborator'];

// Tons escuros da mesma cor para a etiqueta com texto branco: contraste acima de 7:1 (AA pede 4,5:1). O azul e o verde
// do editor (--recipient-*) ficam na borda e no fundo do quadro.
const BOX_LABEL_COLOR: Record<BoxKind, string> = {
  representative: 'hsl(212 72% 34%)',
  collaborator: 'hsl(110 60% 22%)',
};

const BOX_COLOR: Record<BoxKind, string> = {
  representative: '--recipient-blue',
  collaborator: '--recipient-green',
};

/** Os dois quadros começam na última página, lado a lado embaixo. */
export const defaultBoxes = (pageCount: number): ContractBoxes => ({
  representative: { page: pageCount, positionX: 8, positionY: 80, width: 36, height: 9 },
  collaborator: { page: pageCount, positionX: 56, positionY: 80, width: 36, height: 9 },
});

/** Quadro de um rascunho antigo numa página que o PDF novo não tem: volta para a última. */
export const fitBoxesToPages = (boxes: ContractBoxes, pageCount: number): ContractBoxes => ({
  representative: clampSignatureRect({
    ...boxes.representative,
    page: Math.min(boxes.representative.page, pageCount),
  }),
  collaborator: clampSignatureRect({ ...boxes.collaborator, page: Math.min(boxes.collaborator.page, pageCount) }),
});

const resizeWithin = (rect: SignatureRect, width: number, height: number): SignatureRect =>
  clampSignatureRect({
    ...rect,
    width: Math.min(Math.max(width, SIGNATURE_RECT_MIN_WIDTH), 100 - rect.positionX),
    height: Math.min(Math.max(height, SIGNATURE_RECT_MIN_HEIGHT), 100 - rect.positionY),
  });

export type SignatureBoxesEditorProps = {
  pdf: PDFDocumentProxy;
  boxes: ContractBoxes;
  onChange: (kind: BoxKind, rect: SignatureRect) => void;
  currentPage: number;
  onPageChange: (page: number) => void;
};

export const SignatureBoxesEditor = ({
  pdf,
  boxes,
  onChange,
  currentPage,
  onPageChange,
}: SignatureBoxesEditorProps) => {
  const { t } = useLingui();

  const overlayRef = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const pageCount = pdf.numPages;

  const labels: Record<BoxKind, string> = {
    representative: t`Assinatura do representante`,
    collaborator: t`Assinatura do colaborador`,
  };

  const startPointer = (kind: BoxKind, mode: 'move' | 'resize') => (event: PointerEvent<HTMLElement>) => {
    const overlay = overlayRef.current;

    if (!overlay || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    // Foco no quadro: as setas continuam de onde o mouse parou.
    (mode === 'move' ? event.currentTarget : event.currentTarget.parentElement)?.focus();

    const bounds = overlay.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY, rect: boxes[kind] };

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const dx = ((moveEvent.clientX - start.x) / bounds.width) * 100;
      const dy = ((moveEvent.clientY - start.y) / bounds.height) * 100;

      onChange(
        kind,
        mode === 'move'
          ? clampSignatureRect({
              ...start.rect,
              positionX: start.rect.positionX + dx,
              positionY: start.rect.positionY + dy,
            })
          : resizeWithin(start.rect, start.rect.width + dx, start.rect.height + dy),
      );
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const onKeyDown = (kind: BoxKind) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const delta = deltas[event.key];

    if (!delta) {
      return;
    }

    event.preventDefault();

    const step = event.altKey ? 0.25 : 1;
    const rect = boxes[kind];
    const [dx, dy] = [delta[0] * step, delta[1] * step];

    onChange(
      kind,
      event.shiftKey
        ? resizeWithin(rect, rect.width + dx, rect.height + dy)
        : clampSignatureRect({ ...rect, positionX: rect.positionX + dx, positionY: rect.positionY + dy }),
    );
  };

  const moveToPage = (kind: BoxKind, page: number) => {
    onChange(kind, clampSignatureRect({ ...boxes[kind], page }));
    onPageChange(page);
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_290px] lg:items-start" data-testid="contract-boxes-editor">
      <div className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={currentPage <= 1}
            onClick={() => onPageChange(currentPage - 1)}
            aria-label={t`Página anterior`}
          >
            <ChevronLeftIcon className="h-4 w-4" aria-hidden />
          </Button>

          <p className="font-semibold text-sm" aria-live="polite" data-testid="contract-preview-page">
            <Trans>
              Página {currentPage} de {pageCount}
            </Trans>
          </p>

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={currentPage >= pageCount}
            onClick={() => onPageChange(currentPage + 1)}
            aria-label={t`Próxima página`}
          >
            <ChevronRightIcon className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        <PdfPageView
          pdf={pdf}
          pageNumber={currentPage}
          overlayRef={overlayRef}
          className="mx-auto w-full max-w-[720px]"
          label={t`Página ${currentPage} do contrato`}
        >
          {BOX_KINDS.filter((kind) => boxes[kind].page === currentPage).map((kind) => {
            const rect = boxes[kind];
            const color = BOX_COLOR[kind];

            return (
              // Botão: recebe foco e as setas (mover) e Shift + setas (tamanho); o mouse arrasta.
              <button
                type="button"
                key={kind}
                aria-roledescription={t`quadro arrastável`}
                aria-label={t`${labels[kind]}, página ${rect.page}`}
                aria-describedby={helpId}
                data-testid={`signature-box-${kind}`}
                className="absolute flex cursor-move touch-none select-none items-start rounded-[6px] border-2 p-1 text-left outline-none focus:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                style={{
                  left: `${rect.positionX}%`,
                  top: `${rect.positionY}%`,
                  width: `${rect.width}%`,
                  height: `${rect.height}%`,
                  borderColor: `hsl(var(${color}))`,
                  backgroundColor: `hsl(var(${color}) / 0.16)`,
                }}
                onPointerDown={startPointer(kind, 'move')}
                onKeyDown={onKeyDown(kind)}
              >
                <span
                  className="max-w-full truncate rounded-[4px] px-1.5 py-0.5 font-bold text-[11px] text-white leading-tight"
                  style={{ backgroundColor: BOX_LABEL_COLOR[kind] }}
                >
                  {labels[kind]}
                </span>

                <span
                  aria-hidden
                  data-testid={`signature-box-${kind}-resize`}
                  className="absolute -right-1.5 -bottom-1.5 h-4 w-4 cursor-se-resize rounded-full border-2 border-white shadow"
                  style={{ backgroundColor: `hsl(var(${color}))` }}
                  onPointerDown={startPointer(kind, 'resize')}
                />
              </button>
            );
          })}
        </PdfPageView>
      </div>

      <div className="flex flex-col gap-3">
        {BOX_KINDS.map((kind) => {
          const rect = boxes[kind];
          const selectId = `${helpId}-${kind}-page`;

          return (
            <div
              key={kind}
              className={cn('rounded-xl border-[1.5px] p-3.5', rect.page === currentPage ? 'bg-card' : 'bg-muted/40')}
              style={{ borderColor: `hsl(var(${BOX_COLOR[kind]}))` }}
              data-testid={`signature-box-card-${kind}`}
            >
              <p className="flex items-center gap-2 font-bold text-sm">
                <span
                  aria-hidden
                  className="h-3 w-3 shrink-0 rounded-[3px]"
                  style={{ backgroundColor: `hsl(var(${BOX_COLOR[kind]}))` }}
                />
                {labels[kind]}
              </p>

              <div className="mt-2.5 flex items-center gap-2">
                <label htmlFor={selectId} className="text-muted-foreground text-sm">
                  <Trans>Página</Trans>
                </label>
                <select
                  id={selectId}
                  className="h-9 rounded-lg border-[1.5px] border-input bg-card px-2.5 text-sm focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={rect.page}
                  onChange={(event) => moveToPage(kind, Number(event.target.value))}
                  data-testid={`signature-box-page-${kind}`}
                >
                  {Array.from({ length: pageCount }, (_, index) => (
                    <option key={index + 1} value={index + 1}>
                      {index + 1}
                    </option>
                  ))}
                </select>

                {rect.page !== currentPage && (
                  <Button type="button" variant="link" size="sm" onClick={() => onPageChange(rect.page)}>
                    <Trans>Mostrar</Trans>
                  </Button>
                )}
              </div>
            </div>
          );
        })}

        <p id={helpId} className="text-muted-foreground text-xs leading-relaxed">
          <Trans>
            Arraste cada quadro até o lugar da assinatura e puxe o canto para mudar o tamanho. No teclado: as setas
            movem o quadro e Shift + setas mudam o tamanho.
          </Trans>
        </p>
      </div>
    </div>
  );
};
