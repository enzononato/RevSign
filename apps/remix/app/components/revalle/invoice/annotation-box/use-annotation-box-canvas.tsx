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
const LABEL_OFFSET_PX = 40;

type ScreenRect = { x: number; y: number; width: number; height: number };

type UseAnnotationBoxCanvasOptions = {
  stage: MutableRefObject<Konva.Stage | null>;
  pageLayer: MutableRefObject<Konva.Layer | null>;
  pageData: PageRenderData;
  envelopeItemId: string | null;
  /** Algum campo do upstream está selecionado: o bloco deixa de estar. */
  isFieldSelected: boolean;
  /** O bloco foi selecionado: o renderizador limpa a seleção dos campos. */
  onSelect: () => void;
};

/**
 * O bloco "Conta e centro de custo" numa página do editor: um grupo Konva próprio (fora dos campos do upstream: não entra
 * na seleção em área, no seletor de destinatário nem nos campos salvos), abaixo dos campos (a assinatura por cima continua
 * clicável), com o seu Transformer por cima de tudo. O texto de exemplo fica no alto e à esquerda, na fonte e no azul do
 * PDF final, e passa da borda de baixo como na selagem. A etiqueta e o botão de tirar são HTML sobre o canvas (`overlay`,
 * para o renderizador da página pôr ao lado do canvas).
 *
 * Chamar depois do `usePageRenderer`: o efeito que desenha precisa rodar depois do que cria o palco.
 */
export const useAnnotationBoxCanvas = ({
  stage,
  pageLayer,
  pageData,
  envelopeItemId,
  isFieldSelected,
  onSelect,
}: UseAnnotationBoxCanvasOptions): { overlay: ReactNode } => {
  const { t } = useLingui();
  const { isEnabled, boxOf, moveBox, removeBox } = useAnnotationBoxes();

  const { pageNumber, pageWidth, pageHeight, scale, imageLoadingState } = pageData;

  const box = isEnabled ? boxOf(envelopeItemId) : null;
  const pageBox = box && box.page === pageNumber ? box : null;

  const rectRef = useRef<Konva.Rect | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const isSelectedRef = useRef(false);
  const onSelectRef = useRef(onSelect);

  onSelectRef.current = onSelect;

  const [isSelected, setIsSelected] = useState(false);
  const [isChanging, setIsChanging] = useState(false);
  const [screenRect, setScreenRect] = useState<ScreenRect | null>(null);

  const placeholder = [t`Conta: (conta aprovada)`, t`CC: (centro de custo)`].join('\n');

  const select = (value: boolean) => {
    if (value && !isSelectedRef.current) {
      onSelectRef.current();
    }

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

    // O Transformer segura o retângulo (não o grupo): o texto que passa da borda não aumenta a área de redimensionar.
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
    group.moveToBottom();
    layer.add(transformer);

    rectRef.current = rect;
    transformerRef.current = transformer;

    const syncScreenRect = () => setScreenRect(rect.getClientRect({ skipStroke: true, skipShadow: true }));

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
    group.on('dragstart', () => setIsChanging(true));
    group.on('dragmove', syncScreenRect);
    group.on('dragend', () => {
      setIsChanging(false);
      commit();
    });

    rect.on('transformstart', () => setIsChanging(true));

    // Redimensiona o retângulo em vez de esticar: o texto de exemplo não deforma.
    rect.on('transform', () => {
      const nextWidth = rect.width() * rect.scaleX();
      const nextHeight = rect.height() * rect.scaleY();

      rect.setAttrs({ width: nextWidth, height: nextHeight, scaleX: 1, scaleY: 1 });
      text.setAttrs({
        x: rect.x() + ANNOTATION_BOX_PADDING_PT,
        y: rect.y() + ANNOTATION_BOX_PADDING_PT,
        width: Math.max(1, nextWidth - ANNOTATION_BOX_PADDING_PT * 2),
      });
      syncScreenRect();
    });

    // A âncora de cima ou da esquerda move o retângulo dentro do grupo: o grupo vai para lá e o retângulo volta a 0,0.
    rect.on('transformend', () => {
      group.position({ x: group.x() + rect.x(), y: group.y() + rect.y() });
      rect.position({ x: 0, y: 0 });
      text.position({ x: ANNOTATION_BOX_PADDING_PT, y: ANNOTATION_BOX_PADDING_PT });
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

    transformer.nodes(isSelectedRef.current ? [rect] : []);
    transformer.moveToTop();
    syncScreenRect();
    layer.batchDraw();

    return () => {
      currentStage.off(LISTENER_NAMESPACE);
      currentStage.container().style.cursor = '';
      transformer.destroy();
      group.destroy();
      rectRef.current = null;
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
    const rect = rectRef.current;
    const transformer = transformerRef.current;

    if (!rect || !transformer) {
      return;
    }

    transformer.nodes(isSelected ? [rect] : []);
    // Os campos sobem ao serem selecionados (`moveToTop` do upstream): as alças do bloco ficam sempre por cima.
    transformer.moveToTop();
    transformer.getLayer()?.batchDraw();
  }, [isSelected, screenRect !== null]);

  useEffect(() => {
    if (isFieldSelected) {
      select(false);
    }
  }, [isFieldSelected]);

  // Outro arquivo, ou o bloco tirado: nada fica selecionado.
  useEffect(() => {
    select(false);
  }, [envelopeItemId]);

  useEffect(() => {
    if (!pageBox) {
      select(false);
    }
  }, [pageBox === null]);

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
            className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-sm bg-gray-900 text-gray-300 transition-colors hover:text-white"
            data-testid="annotation-box-remove"
            onClick={() => {
              select(false);
              removeBox(envelopeItemId);
            }}
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );

  return { overlay };
};
