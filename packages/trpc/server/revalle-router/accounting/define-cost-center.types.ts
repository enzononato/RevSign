import { z } from 'zod';

export const ZDefineCostCenterRequestSchema = z.object({
  envelopeId: z.string().min(1),
  /** Fase 9: a nota (o arquivo). Obrigatório com 2+ notas (senão 400 `INVOICE_FILE_REQUIRED`); sem ele, a nota única. */
  envelopeItemId: z.string().min(1).optional(),
  code: z.string().trim().min(1).max(50),
});

export const ZDefineCostCenterResponseSchema = z.void();
