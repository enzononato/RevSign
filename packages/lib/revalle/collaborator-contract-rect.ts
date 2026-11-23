import { z } from 'zod';

// REVALLE (v.22): contrato para colaboradores pela página própria. Os quadros de assinatura (representante e
// colaborador) chegam do assistente em % da página como ela aparece na tela (já girada), com a página contada a partir
// de 1 — a mesma convenção dos campos do Documenso, então o quadro (preso dentro da página) vira o campo sem conversão.

/** Quadro em % da página vista na tela; `page` começa em 1. */
export type SignatureRect = { page: number; positionX: number; positionY: number; width: number; height: number };

/** Menor quadro aceito, em % da página: dá para assinar dentro dele. */
export const SIGNATURE_RECT_MIN_WIDTH = 10;
export const SIGNATURE_RECT_MIN_HEIGHT = 4;

export const ZSignatureRectSchema = z.object({
  page: z.number().int().min(1).max(10_000),
  positionX: z.number().finite(),
  positionY: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
});

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** O quadro preso dentro da página: tamanho entre o mínimo e 100%, e a posição sem passar da borda. */
export const clampSignatureRect = (rect: SignatureRect): SignatureRect => {
  const width = clamp(rect.width, SIGNATURE_RECT_MIN_WIDTH, 100);
  const height = clamp(rect.height, SIGNATURE_RECT_MIN_HEIGHT, 100);

  return {
    page: Math.max(1, Math.floor(rect.page)),
    positionX: clamp(rect.positionX, 0, 100 - width),
    positionY: clamp(rect.positionY, 0, 100 - height),
    width,
    height,
  };
};

export type PageGeometry = { width: number; height: number; rotation: 0 | 90 | 180 | 270 };

/**
 * O quadro (preso dentro da página) em pontos do PDF, na página sem a rotação e com a origem no canto de baixo à
 * esquerda (como o pdf-lib desenha). `page.width`/`page.height` são os da página sem rotação. Com `/Rotate` 90 a tela
 * mostra a página girada no sentido horário: o canto de cima à esquerda da tela é o (0, 0) do PDF.
 */
export const mapRectToPage = (
  rect: SignatureRect,
  page: PageGeometry,
): { x: number; y: number; width: number; height: number } => {
  const { positionX, positionY, width, height } = clampSignatureRect(rect);
  const { width: pageWidth, height: pageHeight } = page;
  const isQuarterTurn = page.rotation === 90 || page.rotation === 270;

  // Tamanho da página como aparece na tela.
  const viewWidth = isQuarterTurn ? pageHeight : pageWidth;
  const viewHeight = isQuarterTurn ? pageWidth : pageHeight;

  const left = (positionX / 100) * viewWidth;
  const top = (positionY / 100) * viewHeight;
  const boxWidth = (width / 100) * viewWidth;
  const boxHeight = (height / 100) * viewHeight;

  switch (page.rotation) {
    case 90:
      return { x: top, y: left, width: boxHeight, height: boxWidth };
    case 180:
      return { x: pageWidth - left - boxWidth, y: top, width: boxWidth, height: boxHeight };
    case 270:
      return { x: pageWidth - top - boxHeight, y: pageHeight - left - boxWidth, width: boxHeight, height: boxWidth };
    default:
      return { x: left, y: pageHeight - top - boxHeight, width: boxWidth, height: boxHeight };
  }
};
