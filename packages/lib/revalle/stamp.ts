import { formatRevalleDateTime } from './date-format';

export type RevalleStampInput = {
  nome: string;
  cpfMasked: string | null;
  signedAt: Date;
  verificationCode: string;
  baseUrl: string;
};

/** Linhas prontas do carimbo de um destinatário (montadas a partir da prova congelada). */
export type RevalleStamp = { lines: string[] };

export type RevalleStampBox = { x: number; y: number; width: number; height: number };

export type RevalleStampLayout = {
  fontSize: number;
  lineHeight: number;
  lines: string[];
  drawingBox: RevalleStampBox | null;
  textBox: RevalleStampBox;
};

export type RevalleMeasureText = (text: string, size: number) => number;

export const REVALLE_STAMP_MAX_FONT_SIZE = 9;
export const REVALLE_STAMP_MIN_FONT_SIZE = 5;
export const REVALLE_STAMP_LINE_HEIGHT = 1.15;

const FONT_SIZE_STEP = 0.5;
const PADDING = 1;
const DRAWING_SHARE = 0.4;
const SHORT_LINE_INDEXES = [0, 2, 3];

const FONT_SIZES = Array.from(
  { length: (REVALLE_STAMP_MAX_FONT_SIZE - REVALLE_STAMP_MIN_FONT_SIZE) / FONT_SIZE_STEP + 1 },
  (_, index) => REVALLE_STAMP_MAX_FONT_SIZE - index * FONT_SIZE_STEP,
);

export const buildRevalleStampLines = ({
  nome,
  cpfMasked,
  signedAt,
  verificationCode,
  baseUrl,
}: RevalleStampInput): string[] => [
  `Assinado eletronicamente por ${nome.trim().replace(/\s+/g, ' ').toLocaleUpperCase('pt-BR')}`,
  cpfMasked ? `CPF ${cpfMasked}` : 'CPF não verificado',
  `em ${formatRevalleDateTime(signedAt)} (horário de Brasília)`,
  `Código de verificação: ${verificationCode}`,
  `Confira em ${baseUrl.replace(/\/+$/, '')}/verificar`,
];

const splitField = (box: { width: number; height: number }, hasDrawing: boolean) => {
  if (!hasDrawing) {
    return { drawingBox: null, textArea: { x: 0, y: 0, width: box.width, height: box.height } };
  }

  if (box.height > box.width) {
    const drawingHeight = box.height * DRAWING_SHARE;

    return {
      drawingBox: { x: 0, y: 0, width: box.width, height: drawingHeight },
      textArea: { x: 0, y: drawingHeight, width: box.width, height: box.height - drawingHeight },
    };
  }

  const drawingWidth = box.width * DRAWING_SHARE;

  return {
    drawingBox: { x: 0, y: 0, width: drawingWidth, height: box.height },
    textArea: { x: drawingWidth, y: 0, width: box.width - drawingWidth, height: box.height },
  };
};

const inset = (box: RevalleStampBox): RevalleStampBox => ({
  x: box.x + PADDING,
  y: box.y + PADDING,
  width: Math.max(0, box.width - PADDING * 2),
  height: Math.max(0, box.height - PADDING * 2),
});

const breakWord = (word: string, maxWidth: number, size: number, measure: RevalleMeasureText) => {
  const pieces: string[] = [];
  let current = '';

  for (const char of word) {
    if (current && measure(current + char, size) > maxWidth) {
      pieces.push(current);
      current = char;
    } else {
      current += char;
    }
  }

  pieces.push(current);

  return pieces;
};

const wrapLine = (
  line: string,
  maxWidth: number,
  size: number,
  measure: RevalleMeasureText,
  allowWordBreak: boolean,
): string[] | null => {
  const wrapped: string[] = [];
  let current = '';

  for (const word of line.split(' ').filter(Boolean)) {
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

    if (!allowWordBreak) {
      return null;
    }

    const pieces = breakWord(word, maxWidth, size, measure);

    wrapped.push(...pieces.slice(0, -1));
    current = pieces[pieces.length - 1];
  }

  if (current) {
    wrapped.push(current);
  }

  return wrapped;
};

const wrapLines = (
  lines: string[],
  maxWidth: number,
  size: number,
  measure: RevalleMeasureText,
  allowWordBreak: boolean,
): string[] | null => {
  const wrapped: string[] = [];

  for (const line of lines) {
    const result = wrapLine(line, maxWidth, size, measure, allowWordBreak);

    if (!result) {
      return null;
    }

    wrapped.push(...result);
  }

  return wrapped;
};

/**
 * Distribui o carimbo no campo. Prefere fonte menor (até 5 pt) a quebrar uma palavra no meio; se nem assim couber,
 * usa só as linhas 1, 3 e 4. No último caso (campo minúsculo) a altura pode passar do campo, mas o texto nunca some.
 */
export const layoutRevalleStamp = (
  lines: string[],
  box: { width: number; height: number },
  hasDrawing: boolean,
  measure: RevalleMeasureText,
): RevalleStampLayout => {
  const { drawingBox, textArea } = splitField(box, hasDrawing);
  const textBox = inset(textArea);
  const shortLines = SHORT_LINE_INDEXES.flatMap((index) => (lines[index] === undefined ? [] : [lines[index]]));

  const attempts: Array<[string[], boolean]> = [
    [lines, false],
    [shortLines, false],
    [shortLines, true],
  ];

  for (const [candidate, allowWordBreak] of attempts) {
    for (const fontSize of FONT_SIZES) {
      const wrapped = wrapLines(candidate, textBox.width, fontSize, measure, allowWordBreak);

      if (wrapped && wrapped.length * fontSize * REVALLE_STAMP_LINE_HEIGHT <= textBox.height) {
        return { fontSize, lineHeight: REVALLE_STAMP_LINE_HEIGHT, lines: wrapped, drawingBox, textBox };
      }
    }
  }

  return {
    fontSize: REVALLE_STAMP_MIN_FONT_SIZE,
    lineHeight: REVALLE_STAMP_LINE_HEIGHT,
    lines: wrapLines(shortLines, textBox.width, REVALLE_STAMP_MIN_FONT_SIZE, measure, true) ?? shortLines,
    drawingBox,
    textBox,
  };
};
