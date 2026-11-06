import { z } from 'zod';

export const ZInvoiceDocumentTagsRequestSchema = z.object({
  teamId: z.number().int(),
  // Uma página da lista de Documentos (até 100 linhas).
  envelopeIds: z.array(z.string().min(1)).max(100),
});

export const ZInvoiceDocumentTagsResponseSchema = z.array(
  z.object({
    envelopeId: z.string(),
    account: z.object({ code: z.string(), name: z.string().nullable() }).nullable(),
    costCenterCode: z.string().nullable(),
  }),
);

export type TInvoiceDocumentTagsResponse = z.infer<typeof ZInvoiceDocumentTagsResponseSchema>;
