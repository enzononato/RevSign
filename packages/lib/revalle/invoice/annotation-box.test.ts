import { describe, expect, it } from 'vitest';

import {
  ANNOTATION_BOX_DEFAULT,
  ANNOTATION_BOX_MIN,
  ANNOTATION_BOX_PADDING_PT,
  ANNOTATION_TEXT_DESCENT_RATIO,
  clampAnnotationBox,
  layoutAnnotationText,
  placeAnnotationText,
} from './annotation-box';

const measure = (text: string, size: number) => text.length * size * 0.55;
const lines = ['Conta: 342401 - Manutenção Predial', 'CC: 201 - Armazém'];
const words = (list: string[]) => list.join(' ').split(/\s+/).filter(Boolean);
const widest = (list: string[], size: number) => Math.max(...list.map((line) => measure(line, size)));

describe('clampAnnotationBox', () => {
  it('pulls a box that passes the page edge back inside', () => {
    const rect = clampAnnotationBox({ page: 1, positionX: 95, positionY: 98, width: 30, height: 7 });

    expect(rect.positionX + rect.width).toBeLessThanOrEqual(100);
    expect(rect.positionY + rect.height).toBeLessThanOrEqual(100);
    expect(rect).toEqual({ page: 1, positionX: 70, positionY: 93, width: 30, height: 7 });
  });

  it('raises a box smaller than the minimum and keeps negative positions on the page', () => {
    expect(clampAnnotationBox({ page: 2, positionX: -5, positionY: -1, width: 1, height: 0 })).toEqual({
      page: 2,
      positionX: 0,
      positionY: 0,
      width: ANNOTATION_BOX_MIN.width,
      height: ANNOTATION_BOX_MIN.height,
    });
  });

  it('caps a box larger than the page and keeps a valid page number', () => {
    expect(clampAnnotationBox({ page: 0, positionX: 10, positionY: 10, width: 150, height: 120 })).toEqual({
      page: 1,
      positionX: 0,
      positionY: 0,
      width: 100,
      height: 100,
    });
  });

  it('keeps a box that is already valid, and the default size is above the minimum', () => {
    const rect = { page: 3, positionX: 10, positionY: 70, ...ANNOTATION_BOX_DEFAULT };

    expect(clampAnnotationBox(rect)).toEqual(rect);
    expect(ANNOTATION_BOX_DEFAULT.width).toBeGreaterThanOrEqual(ANNOTATION_BOX_MIN.width);
    expect(ANNOTATION_BOX_DEFAULT.height).toBeGreaterThanOrEqual(ANNOTATION_BOX_MIN.height);
  });
});

describe('layoutAnnotationText', () => {
  it('keeps the largest size and the lines when the box is wide enough', () => {
    expect(layoutAnnotationText({ lines, boxWidthPt: 400, boxHeightPt: 40, measure, maxSize: 10, minSize: 6 })).toEqual(
      { size: 10, lines },
    );
  });

  it('shrinks the font to fit a narrower box, without wrapping', () => {
    const boxWidthPt = widest(lines, 8);
    const layout = layoutAnnotationText({ lines, boxWidthPt, boxHeightPt: 40, measure, maxSize: 10, minSize: 6 });

    expect(layout.size).toBeGreaterThanOrEqual(6);
    expect(layout.size).toBeLessThan(10);
    expect(layout.lines).toEqual(lines);
    expect(widest(layout.lines, layout.size)).toBeLessThanOrEqual(boxWidthPt);
  });

  it('wraps at the minimum size in a very narrow box and never drops a word', () => {
    const boxWidthPt = 70;
    const layout = layoutAnnotationText({ lines, boxWidthPt, boxHeightPt: 20, measure, maxSize: 10, minSize: 6 });

    expect(layout.size).toBe(6);
    expect(layout.lines.length).toBeGreaterThan(lines.length);
    expect(words(layout.lines)).toEqual(words(lines));
    expect(widest(layout.lines, 6)).toBeLessThanOrEqual(boxWidthPt);
  });

  it('breaks a word longer than the box by letter, keeping every letter', () => {
    const long = ['Conta: 1234567890123456789012345678901234567890'];
    const layout = layoutAnnotationText({
      lines: long,
      boxWidthPt: 40,
      boxHeightPt: 20,
      measure,
      maxSize: 10,
      minSize: 6,
    });

    expect(layout.size).toBe(6);
    expect(layout.lines.join('').replace(/\s+/g, '')).toBe(long[0].replace(/\s+/g, ''));
    expect(widest(layout.lines, 6)).toBeLessThanOrEqual(40);
  });
});

describe('placeAnnotationText', () => {
  it('starts at the top-left corner of the box, one line under the other', () => {
    const box = { x: 59.5, y: 589.4, width: 220, height: 42.1 };
    const placed = placeAnnotationText({ lines, box, pageHeight: 842, measure, maxSize: 10, minSize: 6 });

    expect(placed.size).toBe(10);
    expect(placed.lines.map((line) => line.x)).toEqual([
      box.x + ANNOTATION_BOX_PADDING_PT,
      box.x + ANNOTATION_BOX_PADDING_PT,
    ]);
    expect(placed.lines[0].baseline).toBeCloseTo(box.y + ANNOTATION_BOX_PADDING_PT + 11);
    expect(placed.lines[1].baseline - placed.lines[0].baseline).toBeCloseTo(14);
  });

  // A linha de base menos a descida, em coordenadas do PDF (origem no pé da página), nunca abaixo de 0.
  const lowestPdfY = (placed: ReturnType<typeof placeAnnotationText>, pageHeight: number) =>
    Math.min(...placed.lines.map((line) => pageHeight - line.baseline - placed.size * ANNOTATION_TEXT_DESCENT_RATIO));

  it.each([
    ['portrait', 842, 595],
    ['landscape', 595, 842],
  ])('keeps a box at the bottom edge on the page (%s)', (_name, pageHeight, pageWidth) => {
    const rect = clampAnnotationBox({ page: 1, positionX: 10, positionY: 99, width: 45, height: 1 });
    const box = {
      x: (rect.positionX / 100) * pageWidth,
      y: (rect.positionY / 100) * pageHeight,
      width: (rect.width / 100) * pageWidth,
      height: (rect.height / 100) * pageHeight,
    };
    const placed = placeAnnotationText({ lines, box, pageHeight, measure, maxSize: 10, minSize: 6 });

    expect(rect.height).toBe(ANNOTATION_BOX_MIN.height);
    expect(placed.size).toBe(10);
    expect(lowestPdfY(placed, pageHeight)).toBeGreaterThanOrEqual(0);
    // Duas linhas na fonte 10 cabem no bloco mínimo, então o texto fica dentro dele.
    expect(placed.lines[0].baseline - 10 * 1.1).toBeGreaterThanOrEqual(box.y);
  });

  it('moves a narrow box with four wrapped lines up so the last line stays on the page', () => {
    const pageHeight = 842;
    const box = { x: 520, y: pageHeight - 20, width: 50, height: 20 };
    const placed = placeAnnotationText({ lines, box, pageHeight, measure, maxSize: 10, minSize: 6 });

    expect(placed.size).toBe(6);
    expect(placed.lines.length).toBeGreaterThanOrEqual(4);
    expect(words(placed.lines.map((line) => line.text))).toEqual(words(lines));
    expect(lowestPdfY(placed, pageHeight)).toBeGreaterThanOrEqual(0);
    expect(placed.lines[0].baseline - 6 * 1.1).toBeLessThan(box.y + ANNOTATION_BOX_PADDING_PT);
  });
});
