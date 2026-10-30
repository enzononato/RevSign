import { z } from 'zod';

// Texto colado (`csv`) ou arquivo enviado em base64 (`csvBase64`, decodificado no servidor). Arquivo até 1 MB.
export const ZAccountsCsvInputSchema = z
  .object({
    csv: z.string().max(1_000_000).optional(),
    csvBase64: z.string().max(1_400_000).optional(),
  })
  .refine((input) => (input.csv === undefined) !== (input.csvBase64 === undefined), {
    message: 'Envie o texto ou o arquivo, um dos dois',
  });

export const ZParsedAccountSchema = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(['PAYABLE', 'RECEIVABLE']).nullable(),
});

export const ZAdminPreviewAccountsRequestSchema = ZAccountsCsvInputSchema;

export const ZAdminPreviewAccountsResponseSchema = z.object({
  accounts: z.array(ZParsedAccountSchema),
  errors: z.array(z.object({ line: z.number(), message: z.string() })),
  encoding: z.enum(['utf-8', 'windows-1252']),
});

export type TAdminPreviewAccountsRequest = z.infer<typeof ZAdminPreviewAccountsRequestSchema>;
