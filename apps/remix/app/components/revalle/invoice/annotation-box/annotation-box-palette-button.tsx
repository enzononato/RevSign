import { useDocumentElement } from '@documenso/lib/client-only/hooks/use-document-element';
import { PDF_VIEWER_PAGE_SELECTOR } from '@documenso/lib/constants/pdf-viewer';
import { ANNOTATION_BOX_DEFAULT } from '@documenso/lib/revalle/invoice/annotation-box';
import { cn } from '@documenso/ui/lib/utils';
import { Trans, useLingui } from '@lingui/react/macro';
import { ReceiptTextIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { useAnnotationBoxes } from './use-annotation-boxes';

type Ghost = { x: number; y: number; width: number; height: number; isOverPage: boolean };

/**
 * O botão "Conta e centro de custo" da paleta do editor, abaixo de "Assinatura": tracejado e cinza-azulado, para não
 * parecer um campo de assinatura. Mesmo gesto da paleta do upstream: arrastar até a página, ou clicar e depois clicar na
 * página (Esc desiste). Um bloco por arquivo: pôr de novo move o que já existe (com o tamanho dele).
 */
export const AnnotationBoxPaletteButton = ({ envelopeItemId }: { envelopeItemId: string | null }) => {
  const { t } = useLingui();
  const { isEnabled, boxOf, placeBox } = useAnnotationBoxes({ refetchOnMount: true });
  const { getPage } = useDocumentElement();

  const [isPlacing, setIsPlacing] = useState(false);
  const [ghost, setGhost] = useState<Ghost | null>(null);

  const existing = boxOf(envelopeItemId);
  const size = existing
    ? { width: existing.width, height: existing.height }
    : { width: ANNOTATION_BOX_DEFAULT.width, height: ANNOTATION_BOX_DEFAULT.height };

  const stopPlacing = () => {
    setIsPlacing(false);
    setGhost(null);
  };

  const onMouseMove = useCallback(
    (event: MouseEvent) => {
      const $page = document.querySelector(PDF_VIEWER_PAGE_SELECTOR);
      const pageRect = $page?.getBoundingClientRect();
      const width = pageRect ? (pageRect.width * size.width) / 100 : 160;
      const height = pageRect ? (pageRect.height * size.height) / 100 : 40;

      setGhost({
        x: event.clientX - width / 2,
        y: event.clientY - height / 2,
        width,
        height,
        isOverPage: getPage(event, PDF_VIEWER_PAGE_SELECTOR) !== null,
      });
    },
    [size.width, size.height],
  );

  const onMouseUp = useCallback(
    (event: MouseEvent) => {
      const $page = getPage(event, PDF_VIEWER_PAGE_SELECTOR);

      if (!$page || !envelopeItemId) {
        stopPlacing();

        return;
      }

      const { top, left, width, height } = $page.getBoundingClientRect();
      const pageNumber = Number.parseInt($page.getAttribute('data-page-number') ?? '1', 10);

      placeBox(envelopeItemId, {
        page: pageNumber,
        positionX: ((event.clientX - left) / width) * 100 - size.width / 2,
        positionY: ((event.clientY - top) / height) * 100 - size.height / 2,
        width: size.width,
        height: size.height,
      });

      stopPlacing();
    },
    [envelopeItemId, size.width, size.height, placeBox],
  );

  useEffect(() => {
    if (!isPlacing) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        stopPlacing();
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isPlacing, onMouseMove, onMouseUp]);

  if (!isEnabled) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        disabled={!envelopeItemId}
        onClick={() => setIsPlacing(true)}
        onMouseDown={() => setIsPlacing(true)}
        data-selected={isPlacing ? true : undefined}
        data-testid="annotation-box-palette-button"
        className={cn(
          'mt-2.5 flex h-12 w-full cursor-pointer items-center justify-center gap-x-1.5 rounded-lg border-2 border-slate-400 border-dashed bg-slate-50 px-4 text-slate-600 text-sm transition-colors',
          'hover:border-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 data-[selected]:border-slate-600 data-[selected]:bg-slate-100',
          'dark:border-slate-500 dark:bg-slate-900 dark:text-slate-300',
        )}
      >
        <ReceiptTextIcon className="h-4 w-4 flex-shrink-0" />
        <Trans>Conta e centro de custo</Trans>
      </button>

      {isPlacing && ghost && (
        <div
          className={cn(
            'pointer-events-none fixed z-50 flex flex-col justify-start rounded-[2px] border-2 border-slate-500 border-dashed bg-slate-50/90 p-1 text-[10px] text-slate-600 leading-tight transition-transform duration-200',
            { '-rotate-6 scale-90 opacity-50': !ghost.isOverPage },
          )}
          style={{ top: ghost.y, left: ghost.x, width: ghost.width, height: ghost.height }}
        >
          <span className="truncate font-medium">{t`Conta e centro de custo`}</span>
        </div>
      )}
    </>
  );
};
