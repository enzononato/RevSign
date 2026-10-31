import { z } from 'zod';

export const ZChangeFinanceAccountRequestSchema = z.object({
  envelopeId: z.string().min(1),
  code: z.string().trim().min(1).max(50),
  reason: z
    .string()
    .trim()
    .min(10, 'Escreva o motivo da troca (de 10 a 500 caracteres).')
    .max(500, 'Escreva o motivo da troca (de 10 a 500 caracteres).'),
});

export const ZChangeFinanceAccountResponseSchema = z.object({
  /** A nova versão da NF (com a conta nova, já aprovada), enviada para todos assinarem de novo. */
  newEnvelopeId: z.string(),
});

export type TChangeFinanceAccountResponse = z.infer<typeof ZChangeFinanceAccountResponseSchema>;
