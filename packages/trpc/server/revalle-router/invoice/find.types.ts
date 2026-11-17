import { FINANCE_STATUSES } from '@documenso/lib/revalle/finance/finance-status';
import { INVOICE_ROW_STATUSES, ZInvoiceFiltersSchema } from '@documenso/lib/revalle/invoice/invoice-filters';
import { ReadStatus, RecipientRole, SendStatus, SigningStatus } from '@prisma/client';
import { z } from 'zod';

import { ZInvoiceDataSummarySchema } from './invoice-state.types';

export const ZFindInvoicesRequestSchema = ZInvoiceFiltersSchema.extend({
  page: z.number().int().min(1).default(1),
  perPage: z.number().int().min(1).max(100).default(20),
});

/** Fase 9: uma linha por nota. `id`, `title`, `link`, `recipients` e `version` são do envio; o resto, da nota. */
export const ZInvoiceListRowSchema = z.object({
  id: z.string(),
  /** Fase 9: o arquivo da nota (a página da NF tem a âncora `#nota-{envelopeItemId}`). */
  envelopeItemId: z.string(),
  /** Fase 9: o nome do arquivo da nota. */
  documentTitle: z.string(),
  /** Fase 9: a posição da nota entre as notas do envio (1 de 1 no envio de uma nota). */
  position: z.object({ index: z.number(), total: z.number() }),
  title: z.string(),
  senderName: z.string(),
  senderEmail: z.string(),
  /** Nula para o rascunho que está com o Financeiro (ainda não enviado). */
  sentAt: z.date().nullable(),
  completedAt: z.date().nullable(),
  status: z.enum(INVOICE_ROW_STATUSES),
  deleted: z.boolean(),
  account: z.object({ code: z.string(), name: z.string().nullable() }).nullable(),
  accountKind: z.enum(['PAYABLE', 'RECEIVABLE']).nullable(),
  suggestion: z.object({ code: z.string(), confidence: z.string() }).nullable(),
  /** Fase 8: lido pela IA; nulo quando os três estão vazios. */
  invoiceData: ZInvoiceDataSummarySchema.nullable(),
  /** Fase 8: outra NF viva (Fase 9: de outro envio) tem uma chave em comum ou o mesmo arquivo desta nota. `false` para quem não é do Financeiro, da Contabilidade nem admin. */
  isPossibleDuplicate: z.boolean(),
  acceptedSuggestion: z.boolean().nullable(),
  financeStatus: z.enum(FINANCE_STATUSES).nullable(),
  version: z.number(),
  approvedBy: z.string().nullable(),
  costCenterCode: z.string().nullable(),
  costCenterLabel: z.string().nullable(),
  costCenterValidatedAt: z.date().nullable(),
  costCenterValidatedBy: z.string().nullable(),
  link: z.string().nullable(),
  /** REVALLE (redesign v3): quem assina, na ordem de assinatura; sem cópia nem visualizador. */
  recipients: z.array(
    z.object({
      name: z.string(),
      email: z.string(),
      signingStatus: z.nativeEnum(SigningStatus),
      role: z.nativeEnum(RecipientRole),
      sendStatus: z.nativeEnum(SendStatus), // REVALLE: estágio no tooltip dos encaixes
      readStatus: z.nativeEnum(ReadStatus), // REVALLE:
    }),
  ),
});

export const ZFindInvoicesResponseSchema = z.object({
  data: z.array(ZInvoiceListRowSchema),
  count: z.number(),
  currentPage: z.number(),
  perPage: z.number(),
  totalPages: z.number(),
});

export type TFindInvoicesResponse = z.infer<typeof ZFindInvoicesResponseSchema>;
