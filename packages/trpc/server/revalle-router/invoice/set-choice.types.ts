import { z } from 'zod';

import { ZInvoiceEnvelopeRequestSchema, ZInvoiceStateSchema } from './invoice-state.types';

export const ZSetInvoiceChoiceRequestSchema = ZInvoiceEnvelopeRequestSchema.extend({
  choice: z.object({ code: z.string().trim().min(1).max(100) }).strict(),
});

export const ZSetInvoiceChoiceResponseSchema = ZInvoiceStateSchema;

export type TSetInvoiceChoiceRequest = z.infer<typeof ZSetInvoiceChoiceRequestSchema>;
