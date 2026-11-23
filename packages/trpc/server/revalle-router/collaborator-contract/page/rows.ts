import { findCollaboratorContractRows } from '@documenso/lib/server-only/revalle/collaborator-contract/page-tracking';

import { collaboratorContractPageProcedure } from './page-procedure';
import { ZFindCollaboratorContractRowsRequestSchema, ZFindCollaboratorContractRowsResponseSchema } from './rows.types';

/** Tabela da página do contrato (filtro, busca e páginas). */
export const findCollaboratorContractRowsRoute = collaboratorContractPageProcedure
  .input(ZFindCollaboratorContractRowsRequestSchema)
  .output(ZFindCollaboratorContractRowsResponseSchema)
  .query(async ({ ctx, input }) => {
    const { contractId, filter, search, page, perPage } = input;

    return await findCollaboratorContractRows({ userId: ctx.user.id, contractId, filter, search, page, perPage });
  });
