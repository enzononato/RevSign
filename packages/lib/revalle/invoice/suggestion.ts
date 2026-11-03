import { z } from 'zod';

export const INVOICE_REASON_MAX_LENGTH = 200;

export const ZInvoiceSuggestionSchema = z.object({
  accountCode: z.string().trim().min(1),
  confidence: z.enum(['alta', 'media', 'baixa']),
  reason: z
    .string()
    .trim()
    .transform((reason) => reason.slice(0, INVOICE_REASON_MAX_LENGTH)),
});

export type InvoiceSuggestion = z.infer<typeof ZInvoiceSuggestionSchema>;

/**
 * Soma dos caracteres dos códigos acima da qual a trava sai. Com `gemini-3.5-flash-lite`, 50 mil passaram e 65 mil deram
 * HTTP 400; 30 mil deixam folga para outros modelos. Sem trava a sugestão funciona, só que o código é conferido depois.
 */
export const INVOICE_ACCOUNT_ENUM_MAX_CHARS = 30_000;

/**
 * Formato pedido ao Gemini: `accountCode` limitado aos códigos da lista. Sem isso, o modelo às vezes inventa conta:
 * com o plano real, respondeu 340108 (inexistente) em vez de 340802 em 5 de 10 notas de frete.
 */
export const invoiceResponseSchema = (accountCodes: string[]) => {
  const [firstCode, ...otherCodes] = accountCodes;
  const totalChars = accountCodes.reduce((total, code) => total + code.length, 0);

  if (firstCode === undefined || totalChars > INVOICE_ACCOUNT_ENUM_MAX_CHARS) {
    return ZInvoiceSuggestionSchema;
  }

  return ZInvoiceSuggestionSchema.extend({ accountCode: z.enum([firstCode, ...otherCodes]) });
};

export const validateSuggestion = (raw: unknown, activeCodes: Set<string>): InvoiceSuggestion | null => {
  let candidate = raw;

  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  const parsed = ZInvoiceSuggestionSchema.safeParse(candidate);

  if (!parsed.success || !activeCodes.has(parsed.data.accountCode)) {
    return null;
  }

  return parsed.data;
};
