import { z } from 'zod';

export const ZAdminListFinanceUsersRequestSchema = z.object({
  query: z.string().max(200).optional(),
});

export const ZAdminListFinanceUsersResponseSchema = z.object({
  users: z.array(
    z.object({
      id: z.number(),
      name: z.string().nullable(),
      email: z.string(),
      isFinance: z.boolean(),
    }),
  ),
});

export type TAdminListFinanceUsersResponse = z.infer<typeof ZAdminListFinanceUsersResponseSchema>;
