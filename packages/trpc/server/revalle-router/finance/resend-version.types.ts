import { z } from 'zod';

export const ZResendFinanceVersionRequestSchema = z.object({
  envelopeId: z.string().min(1),
});

export const ZResendFinanceVersionResponseSchema = z.object({
  /** `false`: a nova versão já tinha sido enviada (clique duplo ou repetição); nada foi reenviado. */
  sent: z.boolean(),
});

export type TResendFinanceVersionResponse = z.infer<typeof ZResendFinanceVersionResponseSchema>;
