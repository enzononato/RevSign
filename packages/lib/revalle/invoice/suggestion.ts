import { z } from 'zod';

import { normalizeInvoiceData } from './invoice-data';

export const INVOICE_REASON_MAX_LENGTH = 200;

/**
 * A parte que decide a sugestão: a conta, a confiança e o motivo. É o que `validateSuggestion` exige. Os dados da NF
 * ficam de fora de propósito: um deles com tipo errado não pode custar a conta.
 */
export const ZInvoiceAccountSuggestionSchema = z.object({
  accountCode: z.string().trim().min(1),
  confidence: z.enum(['alta', 'media', 'baixa']),
  reason: z
    .string()
    .trim()
    .transform((reason) => reason.slice(0, INVOICE_REASON_MAX_LENGTH)),
});

/**
 * Formato pedido ao Gemini (Fase 8): a conta mais os dados lidos da NF. Os tipos são estritos e simples (texto e número,
 * `nullable().optional()`), sem regex, tamanho nem transformação: o que o SDK converte vai como `responseSchema` e o
 * Gemini recusa o que não entende. Se mesmo assim o modelo errar o tipo, o SDK lança e o texto bruto cai em
 * `validateSuggestion`, que é tolerante.
 *
 * `trim()` e `finite()` não pedem nada a mais do modelo (os dados são limpos de novo em `normalizeInvoiceData`), mas
 * mudam o que o SDK (`ai` 7 com `@ai-sdk/google` 4.0.39) manda: com `.nullable()` puro, sai
 * `{ anyOf: [{ type }], nullable: true }`; com eles, sai `{ type, nullable: true }`, a forma que a documentação do Gemini
 * descreve. O teste `invoice-data.test.mjs` confere o formato que chega ao servidor.
 */
export const ZInvoiceSuggestionSchema = ZInvoiceAccountSuggestionSchema.extend({
  supplierName: z.string().trim().nullable().optional(),
  invoiceNumber: z.string().trim().nullable().optional(),
  totalAmount: z.number().finite().nullable().optional(),
  accessKey: z.string().trim().nullable().optional(),
});

/**
 * Sugestão validada, no formato gravado em `RevalleInvoiceClassification.suggestion` e no cache. Os quatro dados da NF
 * estão sempre presentes (nulos quando vazios), e `totalAmount` é o valor em reais: a chave `supplierName` é o que
 * separa o cache desta versão do cache de antes dela.
 */
export type InvoiceSuggestion = z.infer<typeof ZInvoiceAccountSuggestionSchema> & {
  supplierName: string | null;
  invoiceNumber: string | null;
  totalAmount: number | null;
  accessKey: string | null;
};

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

  const parsed = ZInvoiceAccountSuggestionSchema.safeParse(candidate);

  if (!parsed.success || !activeCodes.has(parsed.data.accountCode)) {
    return null;
  }

  const { supplierName, invoiceNumber, totalAmountCents, accessKey } = normalizeInvoiceData(candidate);

  return {
    ...parsed.data,
    supplierName,
    invoiceNumber,
    totalAmount: totalAmountCents === null ? null : totalAmountCents / 100,
    accessKey,
  };
};
