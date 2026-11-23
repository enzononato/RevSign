import { listCollaboratorContracts } from '@documenso/lib/server-only/revalle/collaborator-contract/page-contract';

import { ZListCollaboratorContractsRequestSchema, ZListCollaboratorContractsResponseSchema } from './list.types';
import { collaboratorContractPageProcedure } from './page-procedure';

/** Lista da página: título, situação, progresso e data de cada contrato (também os da v.21). */
export const listCollaboratorContractsRoute = collaboratorContractPageProcedure
  .input(ZListCollaboratorContractsRequestSchema)
  .output(ZListCollaboratorContractsResponseSchema)
  .query(async ({ ctx }) => await listCollaboratorContracts({ userId: ctx.user.id }));
