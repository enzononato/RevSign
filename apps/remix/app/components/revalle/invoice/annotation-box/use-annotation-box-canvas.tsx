import type { PageRenderData } from '@documenso/lib/client-only/providers/envelope-render-provider';
import { ANNOTATION_BOX_MIN, ANNOTATION_BOX_PADDING_PT } from '@documenso/lib/revalle/invoice/annotation-box';
import { INVOICE_ANNOTATION_FONT_SIZE } from '@documenso/lib/revalle/invoice/pdf-annotation';
import { konvaTextFontFamily } from '@documenso/lib/universal/field-renderer/field-generic-items';
import { useLingui } from '@lingui/react/macro';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { TrashIcon } from 'lucide-react';
import type { MutableRefObject, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { useAnnotationBoxes } from './use-annotation-boxes';

const BOX_NAME = 'revalle-annotation-box';
const LISTENER_NAMESPACE = '.revalleAnnotationBox';
// O azul do texto no PDF final (`ANNOTATION_COLOR` da selagem).
const PDF_TEXT_COLOR = '#0070c0';
const BOX_STROKE = '#64748b';
const BOX_FILL = 'rgba(241, 245, 249, 0.85)';
// Altura da etiqueta acima do bloco, em pixels de tela; sem espaço acima (bloco no alto da página), ela vai abaixo.
const LABEL_OFFSET_PX = 24;

type ScreenRect = { x: number; y: number; width: number; height: number };

type UseAnnotationBoxCanvasOptions = {
  stage: MutableRefObject<Konva.Stage | null>;
  pageLayer: MutableRefObject<Konva.Layer | null>;
  pageData: PageRenderData;
  envelopeItemId: string | null;
};

/**
 * O bloco "Conta e centro de custo" numa página do editor: um grupo Konva próprio (fora dos campos do upstream: não entra
 * na seleção em área, no seletor de destinatário nem nos campos salvos), com o seu Transformer. O texto de exemplo fica
 * no alto e à esquerda, na fonte e no azul do PDF final. A etiqueta e o botão de tirar são HTML sobre o canvas
 * (`overlay`, para o renderizador da página pôr ao lado do canvas).
 *
 * Chamar depois do `usePageRenderer`: o efeito que desenha precisa rodar depois do que cria o palco.
 */
export const useAnnotationBoxCanvas = ({
  stage,
  pageLayer,
  pageData,
  envelopeItemId,
}: UseAnnotationBoxCanvasOptions): { overlay: ReactNode } => {
  const { t } = useLingui();
  const { isEnabled, boxOf, moveBox, removeBox } = useAnnotationBoxes();

  const { pageNumber, pageWidth, pageHeight, scale, imageLoadingState } = pageData;

  const box = isEnabled ? boxOf(envelopeItemId) : null;
  const pageBox = box && box.page === pageNumber ? box : null;

  const groupRef = useRef<Konva.Group | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const isSelectedRef = useRef(false);

  const [isSelected, setIsSelected] = useState(false);
  const [isChanging, setIsChanging] = useState(false);
  const [screenRect, setScreenRect] = useState<ScreenRect | null>(null);

  const placeholder = [t`Conta: (conta aprovada)`, t`CC: (centro de custo)`].join('\n');

  const select = (value: boolean) => {
    isSelectedRef.current = value;
    setIsSelected(value);
  };

  useEffect(() => {
    const currentStage = stage.current;
    const layer = pageLayer.current;

    if (!currentStage || !layer || !pageBox || !envelopeItemId || imageLoadingState !== 'loaded') {
      setScreenRect(null);

      return;
    }

    const width = (pageBox.width / 100) * pageWidth;
    const height = (pageBox.height / 100) * pageHeight;

    const group = new Konva.Group({
      name: BOX_NAME,
      x: (pageBox.positionX / 100) * pageWidth,
      y: (pageBox.positionY / 100) * pageHeight,
      draggable: true,
    });

    const rect = new Konva.Rect({
      width,
      height,
      fill: BOX_FILL,
      stroke: BOX_STROKE,
      strokeWidth: 1.5,
      dash: [6, 4],
      cornerRadius: 2,
      strokeScaleEnabled: false,
    });

    const text = new Konva.Text({
      x: ANNOTATION_BOX_PADDING_PT,
      y: ANNOTATION_BOX_PADDING_PT,
      width: Math.max(1, width - ANNOTATION_BOX_PADDING_PT * 2),
      // Altura fixa: o texto que não cabe não aparece, e o grupo (e o Transformer) fica do tamanho do bloco.
      height: Math.max(1, height - ANNOTATION_BOX_PADDING_PT * 2),
      text: placeholder,
      fontSize: INVOICE_ANNOTATION_FONT_SIZE,
      lineHeight: 1.4,
      fontFamily: konvaTextFontFamily,
      fill: PDF_TEXT_COLOR,
      wrap: 'word',
      listening: false,
    });

    group.add(rect, text);

    // Posições do palco (com a escala da página): o bloco não sai da página ao arrastar.
    group.dragBoundFunc((pos) => ({
      x: Math.max(0, Math.min(currentStage.width() - rect.width() * scale, pos.x)),
      y: Math.max(0, Math.min(currentStage.height() - rect.height() * scale, pos.y)),
    }));

    const minWidth = (currentStage.width() * ANNOTATION_BOX_MIN.width) / 100;
    const minHeight = (currentStage.height() * ANNOTATION_BOX_MIN.height) / 100;

    const transformer = new Konva.Transformer({
      rotateEnabled: false,
      keepRatio: false,
      flipEnabled: false,
      ignoreStroke: true,
      borderStroke: BOX_STROKE,
      anchorStroke: BOX_STROKE,
      anchorSize: 8,
      boundBoxFunc: (oldBox, newBox) => {
        // Crescer sempre vale: um bloco gravado antes de um mínimo maior ainda pode ser aumentado.
        const isTooSmall =
          (newBox.width < minWidth && newBox.width < oldBox.width) ||
          (newBox.height < minHeight && newBox.height < oldBox.height);
        const isOutside =
          newBox.x < -0.5 ||
          newBox.y < -0.5 ||
          newBox.x + newBox.width > currentStage.width() + 0.5 ||
          newBox.y + newBox.height > currentStage.height() + 0.5;

        return isTooSmall || isOutside ? oldBox : newBox;
      },
    });

    layer.add(group);
    layer.add(transformer);

    groupRef.current = group;
    transformerRef.current = transformer;

    const syncScreenRect = () => setScreenRect(group.getClientRect({ skipStroke: true, skipShadow: true }));

    const commit = () => {
      moveBox(envelopeItemId, {
        page: pageNumber,
        positionX: (group.x() / pageWidth) * 100,
        positionY: (group.y() / pageHeight) * 100,
        width: (rect.width() / pageWidth) * 100,
        height: (rect.height() / pageHeight) * 100,
      });
    };

    group.on('mousedown touchstart', () => select(true));
    group.on('mouseenter', () => {
      currentStage.container().style.cursor = 'move';
    });
    group.on('mouseleave', () => {
      currentStage.container().style.cursor = '';
    });
    group.on('dragstart transformstart', () => setIsChanging(true));
    group.on('dragmove', syncScreenRect);

    // Redimensiona o retângulo em vez de esticar o grupo: o texto de exemplo não deforma.
    group.on('transform', () => {
      const nextWidth = rect.width() * group.scaleX();
      const nextHeight = rect.height() * group.scaleY();

      group.scale({ x: 1, y: 1 });
      rect.size({ width: nextWidth, height: nextHeight });
      text.size({
        width: Math.max(1, nextWidth - ANNOTATION_BOX_PADDING_PT * 2),
        height: Math.max(1, nextHeight - ANNOTATION_BOX_PADDING_PT * 2),
      });
      syncScreenRect();
    });

    group.on('dragend transformend', () => {
      setIsChanging(false);
      commit();
    });

    const isBoxTarget = (target: Konva.Node) =>
      target === group || target.getParent() === group || target.getParent() === transformer;

    currentStage.on(
      `mousedown${LISTENER_NAMESPACE} touchstart${LISTENER_NAMESPACE}`,
      (event: KonvaEventObject<Event>) => {
        if (!isBoxTarget(event.target)) {
          select(false);
        }
      },
    );

    transformer.nodes(isSelectedRef.current ? [group] : []);
    syncScreenRect();
    layer.batchDraw();

    return () => {
      currentStage.off(LISTENER_NAMESPACE);
      currentStage.container().style.cursor = '';
      transformer.destroy();
      group.destroy();
      groupRef.current = null;
      transformerRef.current = null;
    };
  }, [
    imageLoadingState,
    scale,
    pageWidth,
    pageHeight,
    pageNumber,
    envelopeItemId,
    placeholder,
    pageBox?.positionX,
    pageBox?.positionY,
    pageBox?.width,
    pageBox?.height,
  ]);

  useEffect(() => {
    const group = groupRef.current;
    const transformer = transformerRef.current;

    if (!group || !transformer) {
      return;
    }

    transformer.nodes(isSelected ? [group] : []);
    transformer.getLayer()?.batchDraw();
  }, [isSelected, screenRect !== null]);

  // Outro arquivo ou bloco tirado: nada fica selecionado.
  useEffect(() => {
    if (!pageBox) {
      select(false);
    }
  }, [pageBox === null, envelopeItemId]);

  if (!pageBox || !screenRect || !envelopeItemId) {
    return { overlay: null };
  }

  const isLabelBelow = screenRect.y < LABEL_OFFSET_PX;

  const overlay = (
    <div
      className="pointer-events-none absolute"
      style={{ left: screenRect.x, top: screenRect.y, width: screenRect.width, height: screenRect.height, zIndex: 20 }}
      data-testid="annotation-box"
      data-envelope-item-id={envelopeItemId}
      data-page={pageBox.page}
    >
      <div
        className="absolute left-0 flex items-center gap-1 whitespace-nowrap"
        style={isLabelBelow ? { top: screenRect.height + 4 } : { bottom: screenRect.height + 4 }}
      >
        <span
          className="rounded-sm bg-slate-600 px-1.5 py-0.5 font-medium text-[11px] text-white leading-none"
          data-testid="annotation-box-label"
        >
          {t`Conta e centro de custo`}
        </span>

        {isSelected && !isChanging && (
          <button
            type="button"
            title={t`Tirar o bloco`}
            aria-label={t`Tirar o bloco`}
            className="pointer-events-auto rounded-sm bg-gray-900 p-1 text-gray-300 transition-colors hover:text-white"
            data-testid="annotation-box-remove"
            onClick={() => {
              select(false);
              removeBox(envelopeItemId);
            }}
          >
            <TrashIcon className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );

  return { overlay };
};
