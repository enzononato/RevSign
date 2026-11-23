import { describe, expect, it } from 'vitest';

import { clampSignatureRect, mapRectToPage } from './collaborator-contract-rect';

const A4 = { width: 600, height: 800 };

describe('mapRectToPage', () => {
  it('keeps a box dragged to x 95% inside the page', () => {
    const rect = { page: 1, positionX: 95, positionY: 50, width: 20, height: 5 };

    expect(clampSignatureRect(rect)).toEqual({ page: 1, positionX: 80, positionY: 50, width: 20, height: 5 });

    const box = mapRectToPage(rect, { ...A4, rotation: 0 });

    expect(box.x + box.width).toBeCloseTo(600);
    expect(box).toEqual({ x: 480, y: 360, width: 120, height: 40 });
  });

  it('maps a 90° page: the screen top-left corner is the PDF origin', () => {
    // Na tela a página fica 800 de largura por 600 de altura.
    const box = mapRectToPage(
      { page: 2, positionX: 10, positionY: 20, width: 25, height: 10 },
      { ...A4, rotation: 90 },
    );

    expect(box).toEqual({ x: 120, y: 80, width: 60, height: 200 });
  });

  it('never goes below 10% x 4%, nor above the page', () => {
    expect(clampSignatureRect({ page: 1, positionX: -5, positionY: 120, width: 1, height: 0 })).toEqual({
      page: 1,
      positionX: 0,
      positionY: 96,
      width: 10,
      height: 4,
    });

    expect(clampSignatureRect({ page: 1, positionX: 0, positionY: 0, width: 300, height: 300 })).toMatchObject({
      width: 100,
      height: 100,
    });
  });
});
