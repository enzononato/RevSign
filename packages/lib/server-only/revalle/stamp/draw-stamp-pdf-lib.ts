import type { PDFDocument, PDFFont, PDFPage } from '@cantoo/pdf-lib';
import { degrees } from '@cantoo/pdf-lib';
import type { Signature } from '@prisma/client';

import { DEFAULT_HANDWRITING_FONT_SIZE } from '../../../constants/pdf';
import { layoutRevalleStamp, type RevalleStamp } from '../../../revalle/stamp';

type AdjustPositionForRotation = (
  pageWidth: number,
  pageHeight: number,
  xPos: number,
  yPos: number,
  pageRotationInDegrees: number,
) => { xPos: number; yPos: number };

type DrawRevalleStampPdfLibOptions = {
  pdf: PDFDocument;
  page: PDFPage;
  stamp: RevalleStamp;
  signature: Pick<Signature, 'signatureImageAsBase64' | 'typedSignature'> | null | undefined;
  stampFont: PDFFont;
  signatureFont: PDFFont;
  fieldX: number;
  fieldY: number;
  fieldWidth: number;
  fieldHeight: number;
  pageWidth: number;
  pageHeight: number;
  pageRotationInDegrees: number;
  adjustPositionForRotation: AdjustPositionForRotation;
};

/**
 * Carimbo no caminho V1 (pdf-lib), com o mesmo layout do V2. Cada linha é desenhada como texto real
 * (Noto Sans embutida), com a mesma correção de rotação de página do upstream.
 */
export const drawRevalleStampPdfLib = async ({
  pdf,
  page,
  stamp,
  signature,
  stampFont,
  signatureFont,
  fieldX,
  fieldY,
  fieldWidth,
  fieldHeight,
  pageWidth,
  pageHeight,
  pageRotationInDegrees,
  adjustPositionForRotation,
}: DrawRevalleStampPdfLibOptions) => {
  const imageSignature = signature?.signatureImageAsBase64 || null;
  const typedSignature = signature?.typedSignature?.trim() || null;

  const layout = layoutRevalleStamp(
    stamp.lines,
    { width: fieldWidth, height: fieldHeight },
    Boolean(imageSignature || typedSignature),
    (text, size) => stampFont.widthOfTextAtSize(text, size),
  );

  const rotate = degrees(pageRotationInDegrees);

  // (x, topo) relativos ao campo, origem no topo-esquerda → canto inferior esquerdo no PDF, já rotacionado.
  const toPdf = (x: number, top: number, height: number) => {
    let xPos = fieldX + x;
    let yPos = pageHeight - (fieldY + top) - height;

    if (pageRotationInDegrees !== 0) {
      ({ xPos, yPos } = adjustPositionForRotation(pageWidth, pageHeight, xPos, yPos, pageRotationInDegrees));
    }

    return { x: xPos, y: yPos };
  };

  const box = layout.drawingBox;

  if (box && imageSignature) {
    const image = await pdf.embedPng(imageSignature);
    const scale = Math.min(box.width / image.width, box.height / image.height, 1);
    const width = image.width * scale;
    const height = image.height * scale;

    page.drawImage(image, {
      ...toPdf(box.x + (box.width - width) / 2, box.y + (box.height - height) / 2, height),
      width,
      height,
      rotate,
    });
  } else if (box && typedSignature) {
    const naturalWidth = signatureFont.widthOfTextAtSize(typedSignature, DEFAULT_HANDWRITING_FONT_SIZE);
    const naturalHeight = signatureFont.heightAtSize(DEFAULT_HANDWRITING_FONT_SIZE);
    const size =
      DEFAULT_HANDWRITING_FONT_SIZE *
      Math.min((box.width * 0.95) / naturalWidth, (box.height * 0.9) / naturalHeight, 1);
    const width = signatureFont.widthOfTextAtSize(typedSignature, size);
    const height = signatureFont.heightAtSize(size);

    page.drawText(typedSignature, {
      ...toPdf(box.x + (box.width - width) / 2, box.y + (box.height - height) / 2, height),
      size,
      font: signatureFont,
      rotate,
    });
  }

  const lineHeightPx = layout.fontSize * layout.lineHeight;
  const glyphHeight = stampFont.heightAtSize(layout.fontSize);
  const descent = glyphHeight - stampFont.heightAtSize(layout.fontSize, { descender: false });
  const top = layout.textBox.y + (layout.textBox.height - layout.lines.length * lineHeightPx) / 2;

  layout.lines.forEach((line, index) => {
    const lineBottom = top + index * lineHeightPx + (lineHeightPx + glyphHeight) / 2;

    page.drawText(line, {
      ...toPdf(layout.textBox.x, lineBottom - descent, 0),
      size: layout.fontSize,
      font: stampFont,
      rotate,
    });
  });
};
