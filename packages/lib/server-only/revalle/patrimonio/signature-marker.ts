// REVALLE: integração com o Patrimônio. O modelo Word traz `{{assinatura}}` onde o colaborador assina. Aqui o marcador
// é achado no PDF, coberto de branco, e vira um campo de assinatura de 180 × 54 pt com o canto superior esquerdo no
// início do marcador (empurrado para dentro da página se precisar).

import { PDF } from '@libpdf/core';

import { type BoundingBox, whiteoutRegions } from '../../pdf/auto-place-fields';

export const SIGNATURE_FIELD_WIDTH_PT = 180;
export const SIGNATURE_FIELD_HEIGHT_PT = 54;

/** Espaços (não quebra de linha) tolerados entre as chaves e entre as letras: o texto extraído do PDF às vezes os insere. */
const GAP = '[^\\S\\n]*';

/** `{{assinatura}}` sem diferenciar maiúsculas, com espaços tolerados. Nova a cada uso (a regex global guarda posição). */
export const signatureMarkerRegex = (): RegExp =>
  new RegExp(`\\{${GAP}\\{${GAP}${'assinatura'.split('').join(GAP)}${GAP}\\}${GAP}\\}`, 'gi');

export type MarkerMatch = {
  /** Página, começando em 1. */
  page: number;
  /** Caixa do marcador em pontos, origem embaixo à esquerda (como o PDF). */
  bbox: BoundingBox;
  pageWidth: number;
  pageHeight: number;
};

export type SignatureFieldPlacement = {
  page: number;
  /** Percentuais da página, origem em cima à esquerda (como os campos do Documenso). */
  positionX: number;
  positionY: number;
  width: number;
  height: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** Campo de 180 × 54 pt com o canto superior esquerdo no início do marcador, sempre dentro da página. */
export const placeSignatureField = ({ page, bbox, pageWidth, pageHeight }: MarkerMatch): SignatureFieldPlacement => {
  const width = Math.min(SIGNATURE_FIELD_WIDTH_PT, pageWidth);
  const height = Math.min(SIGNATURE_FIELD_HEIGHT_PT, pageHeight);

  const markerTop = pageHeight - (bbox.y + bbox.height);

  const x = clamp(bbox.x, 0, pageWidth - width);
  const y = clamp(markerTop, 0, pageHeight - height);

  return {
    page,
    positionX: (x / pageWidth) * 100,
    positionY: (y / pageHeight) * 100,
    width: (width / pageWidth) * 100,
    height: (height / pageHeight) * 100,
  };
};

/** Acha os marcadores em todas as páginas de um PDF já carregado. */
export const findSignatureMarkers = (pdfDoc: PDF): MarkerMatch[] => {
  const markers: MarkerMatch[] = [];

  for (const page of pdfDoc.getPages()) {
    for (const match of page.findText(signatureMarkerRegex())) {
      markers.push({
        page: page.index + 1,
        bbox: match.bbox,
        pageWidth: page.width,
        pageHeight: page.height,
      });
    }
  }

  return markers;
};

/**
 * Acha os marcadores, cobre cada um de branco e devolve o PDF limpo e um campo por marcador. Sem marcador, `fields`
 * vem vazio e o PDF volta como veio.
 */
export const applySignatureMarkers = async (
  pdf: Buffer,
): Promise<{ cleanedPdf: Buffer; fields: SignatureFieldPlacement[] }> => {
  const pdfDoc = await PDF.load(new Uint8Array(pdf));
  const markers = findSignatureMarkers(pdfDoc);

  if (markers.length === 0) {
    return { cleanedPdf: pdf, fields: [] };
  }

  whiteoutRegions(
    pdfDoc,
    markers.map((marker) => ({ pageIndex: marker.page - 1, bbox: marker.bbox })),
  );

  return { cleanedPdf: Buffer.from(await pdfDoc.save()), fields: markers.map(placeSignatureField) };
};
