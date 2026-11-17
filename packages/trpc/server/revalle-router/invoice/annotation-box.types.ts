import { z } from 'zod';

import { ZInvoiceEnvelopeRequestSchema } from './invoice-state.types';

/** O bloco "Conta e centro de custo": página a partir de 1, posição e tamanho em % da página (como os campos). */
export const ZAnnotationBoxRectSchema = z.object({
  page: z.number().int().min(1).max(10_000),
  positionX: z.number().finite(),
  positionY: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
});

export const ZAnnotationBoxSchema = ZAnnotationBoxRectSchema.extend({ envelopeItemId: z.string() });

export const ZFindAnnotationBoxesRequestSchema = ZInvoiceEnvelopeRequestSchema;

/** `autoAnnotation`: envio de antes do bloco (a selagem escreve sozinha); o editor não mostra o bloco. */
export const ZFindAnnotationBoxesResponseSchema = z.object({
  boxes: z.array(ZAnnotationBoxSchema),
  autoAnnotation: z.boolean(),
});

export const ZAnnotationBoxItemRequestSchema = ZInvoiceEnvelopeRequestSchema.extend({
  envelopeItemId: z.string().min(1),
});

export const ZSetAnnotationBoxRequestSchema = ZAnnotationBoxItemRequestSchema.extend({
  rect: ZAnnotationBoxRectSchema,
});

export const ZSetAnnotationBoxResponseSchema = ZAnnotationBoxRectSchema;

export const ZDeleteAnnotationBoxRequestSchema = ZAnnotationBoxItemRequestSchema;

export const ZDeleteAnnotationBoxResponseSchema = z.object({ ok: z.literal(true) });

export type TAnnotationBoxRect = z.infer<typeof ZAnnotationBoxRectSchema>;
export type TAnnotationBox = z.infer<typeof ZAnnotationBoxSchema>;
