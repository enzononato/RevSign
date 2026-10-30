import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';

import { firstPagesPdf } from './first-pages-pdf';

const pdfWithPages = async (count: number) => {
  const doc = await PDFDocument.create();

  for (let index = 0; index < count; index++) {
    doc.addPage([200 + index, 300]);
  }

  return await doc.save();
};

describe('firstPagesPdf', () => {
  it('corta para as 5 primeiras páginas, na ordem', async () => {
    const trimmed = await PDFDocument.load(await firstPagesPdf(await pdfWithPages(8)));

    expect(trimmed.getPageCount()).toBe(5);
    expect(trimmed.getPages().map((page) => page.getWidth())).toEqual([200, 201, 202, 203, 204]);
  });

  it('devolve o mesmo arquivo quando já tem até 5 páginas', async () => {
    const bytes = await pdfWithPages(3);

    expect(await firstPagesPdf(bytes)).toBe(bytes);
  });

  it('devolve os bytes originais quando não é PDF', async () => {
    const bytes = new TextEncoder().encode('não é pdf');

    expect(await firstPagesPdf(bytes)).toBe(bytes);
  });
});
