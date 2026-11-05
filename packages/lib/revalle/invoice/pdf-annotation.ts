import { costCenterName } from './cost-centers';

export const INVOICE_ANNOTATION_FONT_SIZE = 10;
export const INVOICE_ANNOTATION_LINE_HEIGHT = 14;
export const INVOICE_ANNOTATION_MARGIN = 18;
// Distância entre o texto e o campo da assinatura.
const GAP = 2;
// Da linha de base até o topo da caixa da linha: a Noto Sans sobe ~1,07 em e desce ~0,29 em.
const BASELINE_OFFSET = 11;

type InvoiceAnnotationRow = {
  accountCode: string | null;
  /** Nome congelado na aprovação, senão o atual da lista. */
  accountName: string | null;
  costCenterCode: string | null;
};

/** "Conta: 342401 - Nome" e "CC: 201 - Armazém"; só as linhas que existem. */
export const invoiceAnnotationLines = ({ accountCode, accountName, costCenterCode }: InvoiceAnnotationRow) => {
  const lines: string[] = [];

  if (accountCode) {
    const name = accountName?.trim();

    lines.push(name ? `Conta: ${accountCode} - ${name}` : `Conta: ${accountCode}`);
  }

  if (costCenterCode) {
    const name = costCenterName(costCenterCode);

    lines.push(name ? `CC: ${costCenterCode} - ${name}` : `CC: ${costCenterCode}`);
  }

  return lines;
};

type AnnotationFieldCandidate = {
  type: string;
  inserted: boolean;
  /** Ordem do arquivo no envelope. */
  itemOrder: number;
  page: number;
  positionX: number | { toString: () => string };
  positionY: number | { toString: () => string };
};

/** Primeiro campo de assinatura: arquivo, página, de cima para baixo, da esquerda para a direita. */
export const pickAnnotationField = <T extends AnnotationFieldCandidate>(fields: T[]): T | null => {
  const candidates = fields.filter(
    (field) => field.inserted && (field.type === 'SIGNATURE' || field.type === 'FREE_SIGNATURE'),
  );

  const sorted = [...candidates].sort(
    (a, b) =>
      a.itemOrder - b.itemOrder ||
      a.page - b.page ||
      Number(a.positionY) - Number(b.positionY) ||
      Number(a.positionX) - Number(b.positionX),
  );

  return sorted[0] ?? null;
};

type Measure = (text: string, size: number) => number;

const breakLongWord = (word: string, maxWidth: number, measure: Measure) => {
  const parts: string[] = [];
  let current = '';

  for (const char of word) {
    if (current && measure(current + char, INVOICE_ANNOTATION_FONT_SIZE) > maxWidth) {
      parts.push(current);
      current = '';
    }

    current += char;
  }

  parts.push(current);

  return parts;
};

const wrapLine = (text: string, maxWidth: number, measure: Measure) => {
  const wrapped: string[] = [];
  let current = '';

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;

    if (measure(candidate, INVOICE_ANNOTATION_FONT_SIZE) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      wrapped.push(current);
    }

    if (measure(word, INVOICE_ANNOTATION_FONT_SIZE) <= maxWidth) {
      current = word;
      continue;
    }

    const parts = breakLongWord(word, maxWidth, measure);

    wrapped.push(...parts.slice(0, -1));
    current = parts.at(-1) ?? '';
  }

  if (current) {
    wrapped.push(current);
  }

  return wrapped;
};

export type InvoiceAnnotationLayout = {
  size: number;
  /** `x` da esquerda da página e `baseline` do topo da página, em pt, no sentido em que a página é vista. */
  lines: { text: string; x: number; baseline: number }[];
};

type LayoutInvoiceAnnotationOptions = {
  lines: string[];
  /** Caixa do campo, em pt, origem no topo-esquerda da página. Nulo: alto da página. */
  field: { x: number; y: number; width: number; height: number } | null;
  page: { width: number; height: number };
  measure: Measure;
};

/**
 * Acima do campo; sem espaço, logo abaixo; sem espaço também abaixo, encostado na margem de cima. Nunca sai da
 * margem: o texto quebra em linhas e recua para a esquerda se o campo estiver muito à direita.
 */
export const layoutInvoiceAnnotation = ({
  lines,
  field,
  page,
  measure,
}: LayoutInvoiceAnnotationOptions): InvoiceAnnotationLayout => {
  const margin = INVOICE_ANNOTATION_MARGIN;
  const maxWidth = page.width - margin * 2;
  const wrapped = lines.flatMap((line) => wrapLine(line, maxWidth, measure));
  const blockHeight = wrapped.length * INVOICE_ANNOTATION_LINE_HEIGHT;
  const blockWidth = Math.max(0, ...wrapped.map((line) => measure(line, INVOICE_ANNOTATION_FONT_SIZE)));

  const x = field ? Math.max(margin, Math.min(field.x, page.width - margin - blockWidth)) : margin;

  let top = margin;

  if (field) {
    const above = field.y - GAP - blockHeight;
    const below = field.y + field.height + GAP;

    if (above >= margin) {
      top = above;
    } else if (below + blockHeight <= page.height - margin) {
      top = below;
    }
  }

  return {
    size: INVOICE_ANNOTATION_FONT_SIZE,
    lines: wrapped.map((text, index) => ({
      text,
      x,
      baseline: top + index * INVOICE_ANNOTATION_LINE_HEIGHT + BASELINE_OFFSET,
    })),
  };
};
