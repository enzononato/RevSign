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
      isFinanceMember: z.boolean(),
      isAccountingMember: z.boolean(),
    }),
  ),
  /** Membros ativos do Financeiro (o nome vem da Fase 6; a Contabilidade tem `accountingMemberCount`). */
  memberCount: z.number(),
  /** Membros ativos da Contabilidade. */
  accountingMemberCount: z.number(),
  /** NFs assinadas por todos esperando a aprovação do Financeiro. */
  awaitingApprovalCount: z.number(),
});

export type TAdminListFinanceUsersResponse = z.infer<typeof ZAdminListFinanceUsersResponseSchema>;
