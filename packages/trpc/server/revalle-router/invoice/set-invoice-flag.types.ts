import { z } from 'zod';

import { ZInvoiceEnvelopeRequestSchema, ZInvoiceStateSchema } from './invoice-state.types';

export const ZSetInvoiceFlagRequestSchema = ZInvoiceEnvelopeRequestSchema.extend({ isInvoice: z.boolean() });

export const ZSetInvoiceFlagResponseSchema = ZInvoiceStateSchema;
