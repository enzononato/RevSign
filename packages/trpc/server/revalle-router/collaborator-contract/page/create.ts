import { createCollaboratorContract } from '@documenso/lib/server-only/revalle/collaborator-contract/page-contract';

import { ZCreateCollaboratorContractRequestSchema, ZCreateCollaboratorContractResponseSchema } from './create.types';
import { collaboratorContractPageProcedure } from './page-procedure';

/** "Enviar para o representante": confere tudo de novo, guarda a lista pronta e envia ao representante. */
export const createCollaboratorContractRoute = collaboratorContractPageProcedure
  .input(ZCreateCollaboratorContractRequestSchema)
  .output(ZCreateCollaboratorContractResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { contractId, rows, ...data } = input;

    // Só contagens: a lista tem nome, e-mail e CPF.
    ctx.logger.info({ input: { contractId, rows: rows.length } });

    return await createCollaboratorContract({
      userId: ctx.user.id,
      contractId,
      ...data,
      rows,
      requestMetadata: ctx.metadata,
    });
  });
