import { getRevalleUserStatus } from '@documenso/lib/server-only/revalle/users/user-status';

import { adminProcedure } from '../../trpc';
import { ZRevalleUserStatusRequestSchema, ZRevalleUserStatusResponseSchema } from './status.types';

/** REVALLE (v.26): situação da conta na tela do usuário (inativado pela folha, "Mantido ativo pelo TI"). Só admin. */
export const revalleUserStatusRoute = adminProcedure
  .input(ZRevalleUserStatusRequestSchema)
  .output(ZRevalleUserStatusResponseSchema)
  .query(async ({ input }) => await getRevalleUserStatus(input.userId));
