import { z } from 'zod';

import { ZInvoiceEnvelopeRequestSchema, ZInvoiceStateSchema } from './invoice-state.types';

/** Fase 9: o remetente diz o tipo de um arquivo do rascunho (nota fiscal, boleto ou outro). */
export const ZSetInvoiceFileKindRequestSchema = ZInvoiceEnvelopeRequestSchema.extend({
  envelopeItemId: z.string().min(1),
  kind: z.enum(['NF', 'BOLETO', 'OTHER']),
});

export const ZSetInvoiceFileKindResponseSchema = ZInvoiceStateSchema;

export type TSetInvoiceFileKindRequest = z.infer<typeof ZSetInvoiceFileKindRequestSchema>;
