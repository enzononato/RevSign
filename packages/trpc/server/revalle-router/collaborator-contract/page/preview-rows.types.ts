import { z } from 'zod';

export const ZPreviewRowsRequestSchema = z
  .object({
    text: z.string().max(2_000_000).optional(),
    rows: z
      .array(z.array(z.string().max(500)).max(50))
      .max(3100)
      .optional(),
  })
  .refine((value) => value.text !== undefined || value.rows !== undefined, {
    message: 'Informe a lista.',
  });

const ZRowIssueSchema = z.enum([
  'E-mail inválido',
  'CPF inválido',
  'CPF não está na base do RH',
  'Colaborador inativo no RH',
  'CPF repetido na lista',
  'E-mail repetido na lista',
]);

export const ZPreviewResultSchema = z.object({
  rows: z.array(
    z.object({
      line: z.number(),
      name: z.string(),
      email: z.string(),
      cpf: z.string(),
      hrName: z.string().nullable(),
      issues: z.array(ZRowIssueSchema),
    }),
  ),
  ready: z.number(),
  withErrors: z.number(),
  duplicates: z.number(),
});

export type TPreviewRowsRequest = z.infer<typeof ZPreviewRowsRequestSchema>;
