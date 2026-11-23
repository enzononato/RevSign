import { saveCollaboratorContractDraft } from '@documenso/lib/server-only/revalle/collaborator-contract/page-contract';

import { collaboratorContractPageProcedure } from './page-procedure';
import {
  ZSaveCollaboratorContractDraftRequestSchema,
  ZSaveCollaboratorContractDraftResponseSchema,
} from './save-draft.types';

/** Rascunho do assistente (gravado a cada passo). A lista de colaboradores não entra no rascunho. */
export const saveCollaboratorContractDraftRoute = collaboratorContractPageProcedure
  .input(ZSaveCollaboratorContractDraftRequestSchema)
  .output(ZSaveCollaboratorContractDraftResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { contractId, data } = input;

    return await saveCollaboratorContractDraft({ userId: ctx.user.id, contractId, fields: data });
  });
