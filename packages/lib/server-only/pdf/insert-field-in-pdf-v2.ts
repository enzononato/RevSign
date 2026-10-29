// sort-imports-ignore
import '../konva/skia-backend';

import type { FieldWithSignature } from '@documenso/prisma/types/field-with-signature';
import type { Canvas } from '@documenso/skia-canvas';
import { FieldType } from '@prisma/client'; // REVALLE:
import Konva from 'konva';

import type { RevalleStamp } from '../../revalle/stamp'; // REVALLE:
import { renderField } from '../../universal/field-renderer/render-field';
import { ensureFontLibrary } from './helpers';

type InsertFieldInPDFV2Options = {
  pageWidth: number;
  pageHeight: number;
  fields: FieldWithSignature[];
  revalleStamps?: Map<number, RevalleStamp>; // REVALLE: carimbo por recipientId
};

export const insertFieldInPDFV2 = async ({
  pageWidth,
  pageHeight,
  fields,
  revalleStamps, // REVALLE:
}: InsertFieldInPDFV2Options) => {
  ensureFontLibrary();

  let stage: Konva.Stage | null = new Konva.Stage({ width: pageWidth, height: pageHeight });
  let layer: Konva.Layer | null = new Konva.Layer();

  // Render the fields onto the layer.
  for (const field of fields) {
    renderField({
      scale: 1,
      field: {
        renderId: field.id.toString(),
        ...field,
        width: Number(field.width),
        height: Number(field.height),
        positionX: Number(field.positionX),
        positionY: Number(field.positionY),
        // REVALLE: todo campo SIGNATURE inserido de quem tem prova recebe o carimbo; sem prova, render do upstream.
        revalleStamp:
          field.type === FieldType.SIGNATURE && field.inserted ? revalleStamps?.get(field.recipientId) : undefined,
      },
      translations: null,
      pageLayer: layer,
      pageWidth,
      pageHeight,
      mode: 'export',
    });
  }

  stage.add(layer);

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const canvas = layer.canvas._canvas as unknown as Canvas;

  // Embed the SVG into the PDF
  const pdf = await canvas.toBuffer('pdf');

  stage.destroy();
  layer.destroy();

  stage = null;
  layer = null;

  return pdf;
};
