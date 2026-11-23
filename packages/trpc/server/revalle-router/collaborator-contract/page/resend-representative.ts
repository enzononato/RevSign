import { resendToRepresentative } from '@documenso/lib/server-only/revalle/collaborator-contract/representative';

import { collaboratorContractPageProcedure } from './page-procedure';
import {
  ZResendCollaboratorContractRepresentativeRequestSchema,
  ZResendCollaboratorContractRepresentativeResponseSchema,
} from './resend-representative.types';

/** "Reenviar para o representante" (enquanto o contrato espera por ele). */
export const resendCollaboratorContractRepresentativeRoute = collaboratorContractPageProcedure
  .input(ZResendCollaboratorContractRepresentativeRequestSchema)
  .output(ZResendCollaboratorContractRepresentativeResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { contractId } = input;

    await resendToRepresentative({ contractId, userId: ctx.user.id, requestMetadata: ctx.metadata });

    return { ok: true as const };
  });
