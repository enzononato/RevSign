import { z } from 'zod';

export const ZApproveFinanceAccountRequestSchema = z.object({
  envelopeId: z.string().min(1),
  /** "Definir e aprovar": a conta de uma NF enviada que ainda não tem conta (marcada depois do envio). */
  code: z.string().trim().min(1).max(50).optional(),
});

export const ZApproveFinanceAccountResponseSchema = z.object({
  /** `false`: a NF já estava aprovada (clique duplo ou repetição); nada foi gravado nem disparado. */
  approved: z.boolean(),
});

export type TApproveFinanceAccountResponse = z.infer<typeof ZApproveFinanceAccountResponseSchema>;
