import { z } from 'zod';

export const ZFinanceMeResponseSchema = z.object({
  isFinance: z.boolean(),
});

export type TFinanceMeResponse = z.infer<typeof ZFinanceMeResponseSchema>;
