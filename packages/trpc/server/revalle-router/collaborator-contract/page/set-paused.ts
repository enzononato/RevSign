import { setCollaboratorContractPagePaused } from '@documenso/lib/server-only/revalle/collaborator-contract/page-tracking';

import { collaboratorContractPageProcedure } from './page-procedure';
import {
  ZSetCollaboratorContractPausedRequestSchema,
  ZSetCollaboratorContractPausedResponseSchema,
} from './set-paused.types';

/** "Pausar envio" / "Retomar envio". */
export const setCollaboratorContractPausedRoute = collaboratorContractPageProcedure
  .input(ZSetCollaboratorContractPausedRequestSchema)
  .output(ZSetCollaboratorContractPausedResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { contractId, paused } = input;

    return await setCollaboratorContractPagePaused({ userId: ctx.user.id, contractId, paused });
  });
