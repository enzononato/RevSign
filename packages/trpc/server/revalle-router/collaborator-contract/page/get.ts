import { getCollaboratorContract } from '@documenso/lib/server-only/revalle/collaborator-contract/page-contract';

import { ZGetCollaboratorContractRequestSchema, ZGetCollaboratorContractResponseSchema } from './get.types';
import { collaboratorContractPageProcedure } from './page-procedure';

/** Página do contrato: dados (também do rascunho), contagens por situação e o representante. */
export const getCollaboratorContractRoute = collaboratorContractPageProcedure
  .input(ZGetCollaboratorContractRequestSchema)
  .output(ZGetCollaboratorContractResponseSchema)
  .query(async ({ ctx, input }) => {
    const { contractId } = input;

    return await getCollaboratorContract({ userId: ctx.user.id, contractId });
  });
