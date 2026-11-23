import { prisma } from '@documenso/prisma';
import { RevalleCollaboratorContractStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import {
  ZDeleteCollaboratorContractDraftRequestSchema,
  ZDeleteCollaboratorContractDraftResponseSchema,
} from './delete-draft.types';
import { collaboratorContractPageProcedure } from './page-procedure';

/**
 * REVALLE (v.22): "Excluir rascunho" na lista. Só rascunho (nada foi enviado); as linhas ligadas saem em cascata e o PDF
 * subido no assistente também, se nenhum documento o usa.
 */
export const deleteCollaboratorContractDraftRoute = collaboratorContractPageProcedure
  .input(ZDeleteCollaboratorContractDraftRequestSchema)
  .output(ZDeleteCollaboratorContractDraftResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { contractId } = input;

    ctx.logger.info({ input: { contractId } });

    const contract = await prisma.revalleCollaboratorContract.findUnique({
      where: { id: contractId },
      select: { status: true, sourcePdfDocumentDataId: true },
    });

    if (!contract) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Rascunho não encontrado.' });
    }

    // O `status` no filtro fecha a corrida com o "Enviar" do assistente.
    const deleted = await prisma.revalleCollaboratorContract.deleteMany({
      where: { id: contractId, status: RevalleCollaboratorContractStatus.DRAFT },
    });

    if (deleted.count === 0) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Este contrato já foi enviado e não pode ser excluído.' });
    }

    const documentDataId = contract.sourcePdfDocumentDataId;

    if (documentDataId) {
      const [usedByItem, usedByContract] = await Promise.all([
        prisma.envelopeItem.findFirst({ where: { documentDataId }, select: { id: true } }),
        prisma.revalleCollaboratorContract.findFirst({
          where: { sourcePdfDocumentDataId: documentDataId },
          select: { id: true },
        }),
      ]);

      if (!usedByItem && !usedByContract) {
        // Sobra do upload: se outra tabela ainda apontar para ele, fica (não atrapalha o rascunho excluído).
        await prisma.documentData.delete({ where: { id: documentDataId } }).catch(() => undefined);
      }
    }

    return { ok: true as const };
  });
