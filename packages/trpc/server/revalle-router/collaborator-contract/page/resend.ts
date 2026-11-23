import { resendCollaboratorInvite } from '@documenso/lib/server-only/revalle/collaborator-contract/page-tracking';

import { collaboratorContractPageProcedure } from './page-procedure';
import { ZResendCollaboratorInviteRequestSchema, ZResendCollaboratorInviteResponseSchema } from './resend.types';

/** "Reenviar" para uma pessoa (429 `RESEND_TOO_SOON` antes de 10 minutos). */
export const resendCollaboratorInviteRoute = collaboratorContractPageProcedure
  .input(ZResendCollaboratorInviteRequestSchema)
  .output(ZResendCollaboratorInviteResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { contractId, queueId } = input;

    return await resendCollaboratorInvite({ userId: ctx.user.id, contractId, queueId, requestMetadata: ctx.metadata });
  });
