import { z } from 'zod';

export const ZDefineFinanceAccountRequestSchema = z.object({
  envelopeId: z.string().min(1),
  code: z.string().trim().min(1).max(50),
});

export const ZDefineFinanceAccountResponseSchema = z.object({
  /** `false`: a conta já tinha sido definida (clique duplo ou repetição); nada foi reenviado. */
  sent: z.boolean(),
});

export type TDefineFinanceAccountResponse = z.infer<typeof ZDefineFinanceAccountResponseSchema>;
