import { z } from 'zod';

import { ZCollaboratorDocStatusSchema, ZContractIdSchema } from './shared.types';

export const ZFindCollaboratorContractRowsRequestSchema = z.object({
  contractId: ZContractIdSchema,
  /** Todos | Na fila | Enviado | Visualizado | Assinado | Recusado | Falhou. */
  filter: z.union([z.literal('ALL'), ZCollaboratorDocStatusSchema]).default('ALL'),
  /** Nome, e-mail ou o CPF completo. */
  search: z.string().trim().max(254).optional(),
  page: z.number().int().min(1).default(1),
  perPage: z.number().int().min(1).max(100).default(50),
});

export const ZFindCollaboratorContractRowsResponseSchema = z.object({
  rows: z.array(
    z.object({
      queueId: z.string(),
      name: z.string(),
      email: z.string(),
      /** `***.456.789-**`; null nos contratos da v.21 (sem CPF). */
      cpfMasked: z.string().nullable(),
      status: ZCollaboratorDocStatusSchema,
      at: z.date().nullable(),
      failureReason: z.string().nullable(),
    }),
  ),
  total: z.number(),
});
