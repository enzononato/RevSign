import { z } from 'zod';

export const ZValidateCostCenterRequestSchema = z.object({
  envelopeId: z.string().min(1),
  /** Fase 9: a nota (o arquivo). Obrigatório com 2+ notas (senão 400 `INVOICE_FILE_REQUIRED`); sem ele, a nota única. */
  envelopeItemId: z.string().min(1).optional(),
});

export const ZValidateCostCenterResponseSchema = z.object({
  /** `false`: o centro já estava validado; nada foi gravado. */
  validated: z.boolean(),
});

export type TValidateCostCenterResponse = z.infer<typeof ZValidateCostCenterResponseSchema>;
