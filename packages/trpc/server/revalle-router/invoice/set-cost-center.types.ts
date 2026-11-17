import { z } from 'zod';

import { ZInvoiceFileRequestSchema, ZInvoiceStateSchema } from './invoice-state.types';

export const ZSetInvoiceCostCenterRequestSchema = ZInvoiceFileRequestSchema.extend({
  code: z.string().trim().min(1).max(100),
});

export const ZSetInvoiceCostCenterResponseSchema = ZInvoiceStateSchema;

export type TSetInvoiceCostCenterRequest = z.infer<typeof ZSetInvoiceCostCenterRequestSchema>;
