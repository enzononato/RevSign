import { CHANGE_REASON_MESSAGE } from '@documenso/lib/revalle/finance/account-change';
import { z } from 'zod';

export const ZChangeFinanceAccountRequestSchema = z.object({
  envelopeId: z.string().min(1),
  /** Fase 9: a nota (o arquivo). Obrigatório com 2+ notas (senão 400 `INVOICE_FILE_REQUIRED`); sem ele, a nota única. */
  envelopeItemId: z.string().min(1).optional(),
  code: z.string().trim().min(1).max(50),
  reason: z.string().trim().min(10, CHANGE_REASON_MESSAGE).max(500, CHANGE_REASON_MESSAGE),
});

export const ZChangeFinanceAccountResponseSchema = z.object({
  /** A nova versão da NF (com a conta nova, já aprovada), enviada para todos assinarem de novo. */
  newEnvelopeId: z.string(),
});

export type TChangeFinanceAccountResponse = z.infer<typeof ZChangeFinanceAccountResponseSchema>;
