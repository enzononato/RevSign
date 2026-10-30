import { z } from 'zod';

export const ZApproveFinanceAccountRequestSchema = z.object({
  envelopeId: z.string().min(1),
});

export const ZApproveFinanceAccountResponseSchema = z.object({
  /** `false`: a NF já estava aprovada (clique duplo ou repetição); nada foi gravado nem disparado. */
  approved: z.boolean(),
});

export type TApproveFinanceAccountResponse = z.infer<typeof ZApproveFinanceAccountResponseSchema>;
