import { z } from 'zod';

import { ZContractStatusSchema } from './shared.types';

export const ZListCollaboratorContractsRequestSchema = z.object({}).optional();

export const ZListCollaboratorContractsResponseSchema = z.object({
  contracts: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: ZContractStatusSchema,
      total: z.number(),
      signed: z.number(),
      createdAt: z.date(),
      isLegacy: z.boolean(),
    }),
  ),
});
