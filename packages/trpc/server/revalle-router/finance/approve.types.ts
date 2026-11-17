import { z } from 'zod';

export const ZApproveFinanceAccountRequestSchema = z.object({
  envelopeId: z.string().min(1),
  /** Fase 9: a nota (o arquivo). Obrigatório com 2+ notas (senão 400 `INVOICE_FILE_REQUIRED`); sem ele, a nota única. */
  envelopeItemId: z.string().min(1).optional(),
  /** "Definir e aprovar": a conta de uma NF enviada que ainda não tem conta (marcada depois do envio). */
  code: z.string().trim().min(1).max(50).optional(),
});

export const ZApproveFinanceAccountResponseSchema = z.object({
  /** `false`: a NF já estava aprovada (clique duplo ou repetição); nada foi gravado nem disparado. */
  approved: z.boolean(),
});

export type TApproveFinanceAccountResponse = z.infer<typeof ZApproveFinanceAccountResponseSchema>;
