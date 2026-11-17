/**
 * O bloco "Conta e centro de custo" que o remetente coloca no editor: onde a selagem escreve a conta e o centro de uma
 * nota. Página (a partir de 1) e posição em percentual da página, como os campos do Documenso. Módulo puro: o editor, as
 * rotas e a selagem usam as mesmas regras.
 */
export type AnnotationBoxRect = {
  page: number;
  positionX: number;
  positionY: number;
  width: number;
  height: number;
};

/** Tamanho inicial (% da página): cabem duas linhas do texto, também numa folha A4 deitada. */
export const ANNOTATION_BOX_DEFAULT: Omit<AnnotationBoxRect, 'page' | 'positionX' | 'positionY'> = {
  width: 30,
  height: 6,
};

/**
 * O menor bloco aceito (% da página). A altura cabe as duas linhas na fonte 10 numa A4 deitada (595 pt: ~32 pt com a
 * folga); a largura, uma linha curta na fonte mínima.
 */
export const ANNOTATION_BOX_MIN: { width: number; height: number } = { width: 12, height: 6 };

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

/** Dentro da página (0 a 100) e nunca menor que o mínimo: o bloco que passa da borda volta para dentro. */
export const clampAnnotationBox = (rect: AnnotationBoxRect): AnnotationBoxRect => {
  const width = clampNumber(rect.width, ANNOTATION_BOX_MIN.width, 100);
  const height = clampNumber(rect.height, ANNOTATION_BOX_MIN.height, 100);

  return {
    page: Math.max(1, Math.floor(Number.isFinite(rect.page) ? rect.page : 1)),
    positionX: clampNumber(rect.positionX, 0, 100 - width),
    positionY: clampNumber(rect.positionY, 0, 100 - height),
    width,
    height,
  };
};

type Measure = (text: string, size: number) => number;

/** Palavra mais larga que o bloco: quebra por letra (nada se perde). */
const breakWord = (word: string, maxWidth: number, size: number, measure: Measure) => {
  const parts: string[] = [];
  let current = '';

  for (const char of word) {
    if (current && measure(current + char, size) > maxWidth) {
      parts.push(current);
      current = '';
    }

    current += char;
  }

  parts.push(current);

  return parts;
};

const wrapLine = (text: string, maxWidth: number, size: number, measure: Measure) => {
  const wrapped: string[] = [];
  let current = '';

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;

    if (measure(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      wrapped.push(current);
    }

    if (measure(word, size) <= maxWidth) {
      current = word;
      continue;
    }

    const parts = breakWord(word, maxWidth, size, measure);

    wrapped.push(...parts.slice(0, -1));
    current = parts.at(-1) ?? '';
  }

  if (current) {
    wrapped.push(current);
  }

  return wrapped;
};

// Passo do encolhimento da fonte, em pt.
const SIZE_STEP = 0.5;

type LayoutAnnotationTextOptions = {
  lines: string[];
  boxWidthPt: number;
  boxHeightPt: number;
  measure: Measure;
  maxSize: number;
  minSize: number;
};

/**
 * A maior fonte (de `maxSize` até `minSize`) em que cada linha cabe na largura do bloco. Nem na mínima: quebra as linhas
 * por palavra (e a palavra maior que o bloco, por letra). Nunca corta: o texto pode passar da borda de baixo do bloco.
 * `boxHeightPt` fica para quem desenha (a altura não encolhe a fonte).
 */
export const layoutAnnotationText = ({
  lines,
  boxWidthPt,
  measure,
  maxSize,
  minSize,
}: LayoutAnnotationTextOptions): { size: number; lines: string[] } => {
  const fits = (size: number) => lines.every((line) => measure(line, size) <= boxWidthPt);

  for (let size = maxSize; size >= minSize; size -= SIZE_STEP) {
    if (fits(size)) {
      return { size, lines: [...lines] };
    }
  }

  if (fits(minSize)) {
    return { size: minSize, lines: [...lines] };
  }

  return { size: minSize, lines: lines.flatMap((line) => wrapLine(line, boxWidthPt, minSize, measure)) };
};

/** Folga entre a borda do bloco e o texto, em pt. */
export const ANNOTATION_BOX_PADDING_PT = 2;
// Altura da linha e distância do topo da linha até a linha de base, em relação à fonte (14 e 11 na fonte 10, como o
// texto automático acima da assinatura).
const LINE_HEIGHT_RATIO = 1.4;
const BASELINE_RATIO = 1.1;
/** Quanto a letra desce abaixo da linha de base, em relação à fonte (a Noto Sans desce ~0,29 em). */
export const ANNOTATION_TEXT_DESCENT_RATIO = 0.3;

/**
 * O texto dentro do bloco, alinhado ao alto e à esquerda. `box` e o retorno em pt, origem no topo-esquerda da página
 * (no sentido em que a página é vista); `baseline` é a linha de base de cada linha. O texto nunca é cortado: se ele
 * passaria do pé da página (bloco no fim da página, ou muitas linhas quebradas), sobe inteiro até caber, mesmo que
 * comece acima do bloco.
 */
export const placeAnnotationText = ({
  lines,
  box,
  pageHeight,
  measure,
  maxSize,
  minSize,
}: {
  lines: string[];
  box: { x: number; y: number; width: number; height: number };
  pageHeight: number;
  measure: Measure;
  maxSize: number;
  minSize: number;
}): { size: number; lines: { text: string; x: number; baseline: number }[] } => {
  const padding = ANNOTATION_BOX_PADDING_PT;
  const layout = layoutAnnotationText({
    lines,
    boxWidthPt: Math.max(1, box.width - padding * 2),
    boxHeightPt: Math.max(1, box.height - padding * 2),
    measure,
    maxSize,
    minSize,
  });
  const { size } = layout;
  const lastBaseline = box.y + padding + size * BASELINE_RATIO + (layout.lines.length - 1) * size * LINE_HEIGHT_RATIO;
  const overflow = lastBaseline + size * ANNOTATION_TEXT_DESCENT_RATIO - (pageHeight - padding);
  const top = box.y + padding - Math.max(0, overflow);

  return {
    size: layout.size,
    lines: layout.lines.map((text, index) => ({
      text,
      x: box.x + padding,
      baseline: top + layout.size * BASELINE_RATIO + index * layout.size * LINE_HEIGHT_RATIO,
    })),
  };
};
