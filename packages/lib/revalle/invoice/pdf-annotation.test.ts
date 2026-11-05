import { describe, expect, it } from 'vitest';

import { invoiceAnnotationLines, layoutInvoiceAnnotation, pickAnnotationField } from './pdf-annotation';

const measure = (text: string, size: number) => text.length * size * 0.55;
const page = { width: 595, height: 842 };
const lines = ['Conta: 342401 - Manutenção Predial', 'CC: 201 - Armazém'];

describe('invoiceAnnotationLines', () => {
  it('writes the account then the cost center, with the frozen account name', () => {
    expect(
      invoiceAnnotationLines({
        accountCode: '342401',
        accountName: 'Manutenção Predial',
        costCenterCode: '201',
      }),
    ).toEqual(lines);
  });

  it('writes only the line that exists, and the bare code when the account has no name', () => {
    expect(invoiceAnnotationLines({ accountCode: '342401', accountName: '  ', costCenterCode: null })).toEqual([
      'Conta: 342401',
    ]);
    expect(invoiceAnnotationLines({ accountCode: null, accountName: null, costCenterCode: '101' })).toEqual([
      'CC: 101 - Puxada',
    ]);
    expect(invoiceAnnotationLines({ accountCode: null, accountName: null, costCenterCode: null })).toEqual([]);
  });
});

type TestField = {
  id: string;
  type: string;
  inserted: boolean;
  itemOrder: number;
  page: number;
  positionX: number;
  positionY: number;
};

const field = (over: Partial<TestField>): TestField => ({
  id: '',
  type: 'SIGNATURE',
  inserted: true,
  itemOrder: 0,
  page: 1,
  positionY: 50,
  positionX: 10,
  ...over,
});

describe('pickAnnotationField', () => {
  it('takes the first signature by file, page, top to bottom, left to right', () => {
    const picked = pickAnnotationField([
      field({ id: 'a', itemOrder: 1, page: 1 }),
      field({ id: 'b', page: 2, positionY: 5 }),
      field({ id: 'c', page: 1, positionY: 60, positionX: 1 }),
      field({ id: 'd', page: 1, positionY: 50, positionX: 40 }),
      field({ id: 'e', page: 1, positionY: 50, positionX: 20 }),
      field({ id: 'f', type: 'TEXT', page: 1, positionY: 1 }),
      field({ id: 'g', inserted: false, page: 1, positionY: 2 }),
    ]);

    expect(picked?.id).toBe('e');
  });

  it('accepts FREE_SIGNATURE and returns null without signature fields', () => {
    expect(pickAnnotationField([field({ id: 'x', type: 'FREE_SIGNATURE' })])?.id).toBe('x');
    expect(pickAnnotationField([field({ type: 'TEXT' })])).toBeNull();
    expect(pickAnnotationField([])).toBeNull();
  });
});

const box = { x: 100, y: 400, width: 180, height: 60 };

describe('layoutInvoiceAnnotation', () => {
  it('puts the text right above the top of the field', () => {
    const layout = layoutInvoiceAnnotation({ lines, field: box, page, measure });

    expect(layout.size).toBe(10);
    expect(layout.lines.map((line) => line.text)).toEqual(lines);
    expect(layout.lines[0].x).toBe(100);
    const bottom = layout.lines[1].baseline + 3;

    expect(bottom).toBeLessThanOrEqual(400);
    expect(bottom).toBeGreaterThan(385);
  });

  it('goes below the field when there is no room above, and against the margin when there is none below either', () => {
    const below = layoutInvoiceAnnotation({ lines, field: { ...box, y: 20 }, page, measure });

    expect(below.lines[0].baseline).toBeGreaterThan(20 + 60);

    const tight = layoutInvoiceAnnotation({
      lines,
      field: { ...box, y: 20, height: 842 - 40 },
      page,
      measure,
    });

    expect(tight.lines[0].baseline).toBeLessThan(18 + 14);
    expect(tight.lines[0].baseline).toBeGreaterThan(18);
  });

  it('with no field, starts at the top of the page inside the margin', () => {
    const layout = layoutInvoiceAnnotation({ lines, field: null, page, measure });

    expect(layout.lines[0].x).toBe(18);
    expect(layout.lines[0].baseline).toBeLessThan(18 + 14);
  });

  it('wraps a long name inside the 18 pt margin and never overflows the page', () => {
    const long = ['Conta: 342401 - ' + 'Manutenção Predial e Reparos Gerais '.repeat(6).trim()];
    const layout = layoutInvoiceAnnotation({ lines: long, field: box, page, measure });

    expect(layout.lines.length).toBeGreaterThan(1);

    for (const line of layout.lines) {
      expect(line.x).toBeGreaterThanOrEqual(18);
      expect(line.x + measure(line.text, 10)).toBeLessThanOrEqual(595 - 18 + 0.001);
    }

    expect(layout.lines.map((line) => line.text).join(' ')).toBe(long[0]);
  });

  it('slides left when the field is at the right edge', () => {
    const layout = layoutInvoiceAnnotation({ lines, field: { ...box, x: 520, width: 60 }, page, measure });
    const widest = Math.max(...layout.lines.map((line) => measure(line.text, 10)));

    expect(layout.lines[0].x).toBeLessThan(520);
    expect(layout.lines[0].x + widest).toBeLessThanOrEqual(595 - 18 + 0.001);
  });

  it('breaks a word that is wider than the line', () => {
    const layout = layoutInvoiceAnnotation({ lines: ['CC: ' + 'X'.repeat(200)], field: box, page, measure });

    for (const line of layout.lines) {
      expect(line.x + measure(line.text, 10)).toBeLessThanOrEqual(595 - 18 + 0.001);
    }
  });
});
