import { z } from 'zod';

export const ZRevalleGateStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('PASSED') }),
  z.object({
    status: z.literal('TERM_REQUIRED'),
    termVersion: z.string(),
    termText: z.string(),
    termNotice: z.string(),
  }),
  z.object({ status: z.literal('IDENTITY_REQUIRED'), attemptsLeft: z.number() }),
  z.object({
    status: z.literal('IDENTITY_CONFIRM'),
    preview: z.object({
      primeiroNome: z.string(),
      cargo: z.string().nullable(),
      unidade: z.string().nullable(),
    }),
  }),
  z.object({ status: z.literal('LOCKED') }),
  z.object({ status: z.literal('UNAVAILABLE') }),
]);
