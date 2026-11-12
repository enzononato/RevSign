import { PDF } from '@libpdf/core';
import { describe, expect, it } from 'vitest';

import { PatrimonioError } from '../../../revalle/patrimonio/request';
import {
  applySignatureMarkers,
  isSupportedMarkerPage,
  placeSignatureField,
  SIGNATURE_FIELD_HEIGHT_PT,
  SIGNATURE_FIELD_WIDTH_PT,
  signatureMarkerRegex,
} from './signature-marker';

const A4 = { width: 595.28, height: 841.89 };

describe('signatureMarkerRegex', () => {
  const matches = (text: string) => text.match(signatureMarkerRegex()) ?? [];

  it.each([
    '{{assinatura}}',
    '{{ASSINATURA}}',
    '{{ Assinatura }}',
    '{ {assinatura} }',
    '{{assin atura}}',
  ])('acha %s', (text) => {
    expect(matches(`Assinatura do colaborador: ${text} fim`)).toHaveLength(1);
  });

  it.each([
    '{assinatura}',
    '{{assinaturas}}',
    '{{assinatura',
    'assinatura',
    '{{\nassinatura}}',
  ])('não acha %s', (text) => {
    expect(matches(text)).toHaveLength(0);
  });

  it('acha mais de um', () => {
    expect(matches('{{assinatura}} e {{Assinatura}}')).toHaveLength(2);
  });
});

describe('placeSignatureField', () => {
  it('canto superior esquerdo no início do marcador, 180 × 54 pt', () => {
    const field = placeSignatureField({
      page: 2,
      bbox: { x: 100, y: 200, width: 80, height: 12 },
      pageWidth: A4.width,
      pageHeight: A4.height,
    });

    expect(field.page).toBe(2);
    expect(field.positionX).toBeCloseTo((100 / A4.width) * 100, 6);
    expect(field.positionY).toBeCloseTo(((A4.height - 212) / A4.height) * 100, 6);
    expect(field.width).toBeCloseTo((SIGNATURE_FIELD_WIDTH_PT / A4.width) * 100, 6);
    expect(field.height).toBeCloseTo((SIGNATURE_FIELD_HEIGHT_PT / A4.height) * 100, 6);
  });

  it('empurra para dentro da página quando o campo passaria da borda direita ou de baixo', () => {
    const field = placeSignatureField({
      page: 1,
      bbox: { x: 500, y: 10, width: 80, height: 12 },
      pageWidth: A4.width,
      pageHeight: A4.height,
    });

    expect(field.positionX + field.width).toBeCloseTo(100, 6);
    expect(field.positionY + field.height).toBeCloseTo(100, 6);
  });

  it('marcador fora do topo ou da esquerda fica no canto', () => {
    const field = placeSignatureField({
      page: 1,
      bbox: { x: -5, y: A4.height, width: 80, height: 12 },
      pageWidth: A4.width,
      pageHeight: A4.height,
    });

    expect(field.positionX).toBe(0);
    expect(field.positionY).toBe(0);
  });

  it('página menor que o campo: o campo ocupa a página toda', () => {
    const field = placeSignatureField({
      page: 1,
      bbox: { x: 10, y: 10, width: 20, height: 5 },
      pageWidth: 100,
      pageHeight: 40,
    });

    expect(field).toMatchObject({ positionX: 0, positionY: 0, width: 100, height: 100 });
  });
});

describe('isSupportedMarkerPage', () => {
  const box = { x: 0, y: 0, width: A4.width, height: A4.height };

  it('página A4 sem rotação, MediaBox em (0, 0) e sem CropBox menor', () => {
    expect(isSupportedMarkerPage({ rotation: 0, mediaBox: box, cropBox: box })).toBe(true);
  });

  it.each([90, 180, 270])('recusa página girada %s°', (rotation) => {
    expect(isSupportedMarkerPage({ rotation, mediaBox: box, cropBox: box })).toBe(false);
  });

  it('recusa MediaBox fora de (0, 0) e CropBox menor', () => {
    const offset = { ...box, x: 10, y: 10 };

    expect(isSupportedMarkerPage({ rotation: 0, mediaBox: offset, cropBox: offset })).toBe(false);
    expect(isSupportedMarkerPage({ rotation: 0, mediaBox: box, cropBox: { ...box, width: 500 } })).toBe(false);
  });
});

describe('applySignatureMarkers (PDF de verdade)', () => {
  const makePdf = (pages: string[][], rotations: Record<number, 0 | 90 | 180 | 270> = {}) => {
    const pdf = PDF.create();

    for (const [pageIndex, lines] of pages.entries()) {
      const page = pdf.addPage({ size: 'a4' });

      page.setRotation(rotations[pageIndex] ?? 0);

      lines.forEach((line, index) => {
        page.drawText(line, { x: 72, y: 700 - index * 40, size: 12 });
      });
    }

    return pdf.save();
  };

  it('acha os marcadores, devolve um campo por marcador e tira o texto do PDF', async () => {
    const bytes = await makePdf([
      ['Termo de entrega', 'Assinatura: {{Assinatura}}'],
      ['Sem marcador aqui'],
      ['Testemunha {{ assinatura }}', 'Outra {{ASSINATURA}}'],
    ]);

    const { cleanedPdf, fields } = await applySignatureMarkers(Buffer.from(bytes));

    expect(fields.map((field) => field.page)).toEqual([1, 3, 3]);

    for (const field of fields) {
      expect(field.width).toBeCloseTo((SIGNATURE_FIELD_WIDTH_PT / A4.width) * 100, 1);
      expect(field.positionY).toBeGreaterThan(0);
      expect(field.positionY + field.height).toBeLessThanOrEqual(100);
    }

    // O marcador da página 1 está na segunda linha (y = 660): o topo do campo fica perto de 841.89 - 660 - altura.
    expect(fields[0].positionY).toBeGreaterThan(((A4.height - 680) / A4.height) * 100);
    expect(fields[0].positionY).toBeLessThan(((A4.height - 660) / A4.height) * 100);

    // O PDF com a cobertura branca continua legível e com as mesmas páginas.
    const reloaded = await PDF.load(new Uint8Array(cleanedPdf));

    expect(reloaded.getPageCount()).toBe(3);
  });

  it('página com marcador girada: INVALID_FILE dizendo a página; girada sem marcador não importa', async () => {
    const rotated = Buffer.from(await makePdf([['Capa'], ['Assinatura: {{assinatura}}']], { 1: 90 }));

    await expect(applySignatureMarkers(rotated)).rejects.toSatisfy(
      (error) => error instanceof PatrimonioError && error.code === 'INVALID_FILE' && /página 2/.test(error.message),
    );

    const otherRotated = Buffer.from(await makePdf([['Capa'], ['Assinatura: {{assinatura}}']], { 0: 90 }));

    expect((await applySignatureMarkers(otherRotated)).fields).toHaveLength(1);
  });

  it('sem marcador: nenhum campo e o PDF volta igual', async () => {
    const bytes = Buffer.from(await makePdf([['Termo sem lugar de assinatura']]));
    const { cleanedPdf, fields } = await applySignatureMarkers(bytes);

    expect(fields).toHaveLength(0);
    expect(cleanedPdf).toBe(bytes);
  });
});
