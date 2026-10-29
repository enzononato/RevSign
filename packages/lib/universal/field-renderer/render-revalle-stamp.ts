import type { Signature } from '@prisma/client';
import Konva from 'konva';

import { DEFAULT_SIGNATURE_TEXT_FONT_SIZE, getSignatureFontFamily } from '../../constants/pdf';
import { layoutRevalleStamp, type RevalleStamp, type RevalleStampBox } from '../../revalle/stamp';

// Noto Sans tem os acentos do português e vira fonte TrueType embutida no PDF (texto extraível).
export const REVALLE_STAMP_FONT_FAMILY = '"Noto Sans"';

type CreateRevalleStampGroupOptions = {
  stamp: RevalleStamp;
  signature: Pick<Signature, 'signatureImageAsBase64' | 'typedSignature'> | null | undefined;
  fieldWidth: number;
  fieldHeight: number;
  createImage: (signatureImageAsBase64: string, width: number, height: number) => Konva.Image;
};

const createTypedDrawing = (typedSignature: string, box: RevalleStampBox) => {
  const fontFamily = getSignatureFontFamily(typedSignature);
  const probe = new Konva.Text({ text: typedSignature, fontFamily, fontSize: DEFAULT_SIGNATURE_TEXT_FONT_SIZE });
  const naturalWidth = probe.measureSize(typedSignature).width;

  probe.destroy();

  const fontSize = Math.min(
    DEFAULT_SIGNATURE_TEXT_FONT_SIZE,
    naturalWidth > 0
      ? (DEFAULT_SIGNATURE_TEXT_FONT_SIZE * box.width * 0.95) / naturalWidth
      : DEFAULT_SIGNATURE_TEXT_FONT_SIZE,
    box.height * 0.9,
  );

  return new Konva.Text({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    text: typedSignature,
    fontFamily,
    fontSize,
    lineHeight: 1,
    align: 'center',
    verticalAlign: 'middle',
    wrap: 'none',
    fill: 'black',
    listening: false,
  });
};

/**
 * Carimbo do PDF final: desenho (imagem ou texto digitado) na área reservada, se houver, e as linhas do carimbo
 * como texto real. O texto não recebe largura/altura fixas para o Konva nunca cortar uma linha.
 */
export const createRevalleStampGroup = ({
  stamp,
  signature,
  fieldWidth,
  fieldHeight,
  createImage,
}: CreateRevalleStampGroupOptions): Konva.Group => {
  const imageSignature = signature?.signatureImageAsBase64 || null;
  const typedSignature = signature?.typedSignature?.trim() || null;

  const probe = new Konva.Text({ fontFamily: REVALLE_STAMP_FONT_FAMILY });
  const measure = (text: string, size: number) => {
    probe.fontSize(size);

    return probe.measureSize(text).width;
  };

  const layout = layoutRevalleStamp(
    stamp.lines,
    { width: fieldWidth, height: fieldHeight },
    Boolean(imageSignature || typedSignature),
    measure,
  );

  probe.destroy();

  const group = new Konva.Group({ name: 'revalle-stamp', listening: false });

  if (layout.drawingBox && imageSignature) {
    const holder = new Konva.Group({ x: layout.drawingBox.x, y: layout.drawingBox.y, listening: false });

    holder.add(createImage(imageSignature, layout.drawingBox.width, layout.drawingBox.height));
    group.add(holder);
  } else if (layout.drawingBox && typedSignature) {
    group.add(createTypedDrawing(typedSignature, layout.drawingBox));
  }

  const textHeight = layout.lines.length * layout.fontSize * layout.lineHeight;

  group.add(
    new Konva.Text({
      x: layout.textBox.x,
      y: layout.textBox.y + (layout.textBox.height - textHeight) / 2,
      text: layout.lines.join('\n'),
      fontFamily: REVALLE_STAMP_FONT_FAMILY,
      fontSize: layout.fontSize,
      lineHeight: layout.lineHeight,
      wrap: 'none',
      fill: 'black',
      listening: false,
    }),
  );

  return group;
};
