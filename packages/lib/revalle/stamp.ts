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

/**
 * FULL: as 5 linhas. WITHOUT_URL: linhas 1–4. ESSENTIAL: linhas 1, 3 e 4 (último recurso; pode passar da altura).
 */
export type RevalleStampLevel = 'FULL' | 'WITHOUT_URL' | 'ESSENTIAL';

export type RevalleStampLayout = {
  level: RevalleStampLevel;
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
const ESSENTIAL_LINE_INDEXES = [0, 2, 3];

// Tamanho do campo de assinatura em % da página. Em A4, o mínimo comporta as 5 linhas em 6 pt sem desenho
// (nome em 2 linhas e endereço em 2); o padrão sai em ~7 pt.
export const REVALLE_SIGNATURE_FIELD_MIN = { width: 26, height: 6.5 };
export const REVALLE_SIGNATURE_FIELD_DEFAULT = { width: 30, height: 8 };

/** Tamanho (em % da página) de um campo de assinatura, nunca abaixo do mínimo do carimbo. */
export const clampRevalleSignatureFieldSize = (size: { width: number; height: number }) => ({
  width: Math.max(size.width, REVALLE_SIGNATURE_FIELD_MIN.width),
  height: Math.max(size.height, REVALLE_SIGNATURE_FIELD_MIN.height),
});

type WrapMode = 'words' | 'soft';

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

/** Quebra um token longo (o endereço) depois de "/" e "."; letra a letra só se um pedaço ainda não couber. */
const appendSoftBroken = (
  current: string,
  word: string,
  maxWidth: number,
  size: number,
  measure: RevalleMeasureText,
) => {
  const done: string[] = [];
  let line = current;
  let separator = current ? ' ' : '';

  for (const segment of word.split(/(?<=[./])/)) {
    const candidate = line + separator + segment;

    separator = '';

    if (measure(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }

    if (line) {
      done.push(line);
    }

    if (measure(segment, size) <= maxWidth) {
      line = segment;
      continue;
    }

    const pieces = breakWord(segment, maxWidth, size, measure);

    done.push(...pieces.slice(0, -1));
    line = pieces[pieces.length - 1];
  }

  return { done, line };
};

const wrapLine = (
  line: string,
  maxWidth: number,
  size: number,
  measure: RevalleMeasureText,
  mode: WrapMode,
): string[] | null => {
  const wrapped: string[] = [];
  let current = '';

  for (const word of line.split(' ').filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;

    if (measure(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (measure(word, size) <= maxWidth) {
      if (current) {
        wrapped.push(current);
      }

      current = word;
      continue;
    }

    if (mode === 'words') {
      return null;
    }

    const { done, line: rest } = appendSoftBroken(current, word, maxWidth, size, measure);

    wrapped.push(...done);
    current = rest;
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
  mode: WrapMode,
): string[] | null => {
  const wrapped: string[] = [];

  for (const line of lines) {
    const result = wrapLine(line, maxWidth, size, measure, mode);

    if (!result) {
      return null;
    }

    wrapped.push(...result);
  }

  return wrapped;
};

/**
 * Distribui o carimbo no campo, de 9 até 5 pt. Ordem: 5 linhas sem quebrar palavra; 5 linhas quebrando o endereço
 * em "/" e "."; linhas 1–4 (sem o endereço); linhas 1, 3 e 4. No último caso (campo minúsculo) a altura pode passar
 * do campo, mas o texto nunca some.
 */
export const layoutRevalleStamp = (
  lines: string[],
  box: { width: number; height: number },
  hasDrawing: boolean,
  measure: RevalleMeasureText,
): RevalleStampLayout => {
  const { drawingBox, textArea } = splitField(box, hasDrawing);
  const textBox = inset(textArea);
  const essentialLines = ESSENTIAL_LINE_INDEXES.flatMap((index) => (lines[index] === undefined ? [] : [lines[index]]));

  const attempts: Array<[RevalleStampLevel, string[], WrapMode]> = [
    ['FULL', lines, 'words'],
    ['FULL', lines, 'soft'],
    ['WITHOUT_URL', lines.slice(0, 4), 'soft'],
    ['ESSENTIAL', essentialLines, 'soft'],
  ];

  for (const [level, candidate, mode] of attempts) {
    for (const fontSize of FONT_SIZES) {
      const wrapped = wrapLines(candidate, textBox.width, fontSize, measure, mode);

      if (wrapped && wrapped.length * fontSize * REVALLE_STAMP_LINE_HEIGHT <= textBox.height) {
        return { level, fontSize, lineHeight: REVALLE_STAMP_LINE_HEIGHT, lines: wrapped, drawingBox, textBox };
      }
    }
  }

  return {
    level: 'ESSENTIAL',
    fontSize: REVALLE_STAMP_MIN_FONT_SIZE,
    lineHeight: REVALLE_STAMP_LINE_HEIGHT,
    lines: wrapLines(essentialLines, textBox.width, REVALLE_STAMP_MIN_FONT_SIZE, measure, 'soft') ?? essentialLines,
    drawingBox,
    textBox,
  };
};

/** Rótulo neutro de uma assinatura "só carimbo" nas telas (o carimbo completo sai no PDF final). */
export const REVALLE_STAMP_ONLY_LABEL = 'Assinado eletronicamente (carimbo)';

type StampOnlyCandidate = {
  type: string;
  inserted?: boolean;
  signature?: { signatureImageAsBase64?: string | null; typedSignature?: string | null } | null;
};

/** Campo SIGNATURE inserido sem desenho nem texto: a marca dele no PDF é só o carimbo. */
export const isRevalleStampOnlySignature = (field: StampOnlyCandidate) =>
  field.type === 'SIGNATURE' &&
  Boolean(field.inserted) &&
  Boolean(field.signature) &&
  !field.signature?.signatureImageAsBase64 &&
  !field.signature?.typedSignature?.trim();
