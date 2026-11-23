import {
  createCollaboratorContractFromEnvelope,
  findCollaboratorContractForSource,
} from '@documenso/lib/server-only/revalle/collaborator-contract/create-from-envelope';
import {
  exportCollaboratorContractCsv,
  getCollaboratorContractStatus,
  setCollaboratorContractPaused,
} from '@documenso/lib/server-only/revalle/collaborator-contract/status';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { prisma } from '@documenso/prisma';
import { TRPCError } from '@trpc/server';

import { authenticatedProcedure, router } from '../../trpc';
import { collaboratorContractPageRouter } from './page/router';
import {
  ZCollaboratorContractFromEnvelopeRequestSchema,
  ZCollaboratorContractSetPausedRequestSchema,
  ZCollaboratorContractTemplateRequestSchema,
} from './router.types';

/**
 * REVALLE (v.21): contrato para colaboradores. Sem sessão = 401; logado sem o papel ADMIN = 403 (o papel é lido do
 * banco, como nas rotas de admin do Financeiro).
 */
const collaboratorContractAdminProcedure = authenticatedProcedure.use(async ({ ctx, next }) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id }, select: { roles: true } });

  if (!isAdmin(user)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Só o administrador pode fazer isso.' });
  }

  return await next();
});

export const collaboratorContractRouter = router({
  /** v.22: a página "Contratos para colaboradores". */
  page: collaboratorContractPageRouter,

  /** "Usar como contrato para colaboradores": cria (ou devolve o já criado neste time) o modelo marcado. */
  createFromEnvelope: collaboratorContractAdminProcedure
    .input(ZCollaboratorContractFromEnvelopeRequestSchema)
    .mutation(async ({ ctx, input }) => {
      ctx.logger.info({ input: { envelopeId: input.envelopeId, teamId: input.teamId } });

      return await createCollaboratorContractFromEnvelope({
        sourceEnvelopeId: input.envelopeId,
        userId: ctx.user.id,
        teamId: input.teamId,
        requestMetadata: ctx.metadata,
      });
    }),

  /** O modelo já criado deste documento neste time (para o botão abrir o mesmo modelo). */
  findForSource: collaboratorContractAdminProcedure
    .input(ZCollaboratorContractFromEnvelopeRequestSchema)
    .query(async ({ input }) => {
      const contract = await findCollaboratorContractForSource({
        sourceEnvelopeId: input.envelopeId,
        teamId: input.teamId,
      });

      return { templateEnvelopeId: contract?.templateEnvelopeId ?? null };
    }),

  /** Quadro "Envio para colaboradores"; modelo comum: null. */
  getStatus: collaboratorContractAdminProcedure
    .input(ZCollaboratorContractTemplateRequestSchema)
    .query(
      async ({ ctx, input }) =>
        await getCollaboratorContractStatus({ templateEnvelopeId: input.templateEnvelopeId, userId: ctx.user.id }),
    ),

  /** "Baixar planilha da situação" (nome;email;situação;data). */
  exportCsv: collaboratorContractAdminProcedure
    .input(ZCollaboratorContractTemplateRequestSchema)
    .mutation(
      async ({ ctx, input }) =>
        await exportCollaboratorContractCsv({ templateEnvelopeId: input.templateEnvelopeId, userId: ctx.user.id }),
    ),

  /** "Pausar envio" / "Retomar envio". */
  setPaused: collaboratorContractAdminProcedure.input(ZCollaboratorContractSetPausedRequestSchema).mutation(
    async ({ ctx, input }) =>
      await setCollaboratorContractPaused({
        templateEnvelopeId: input.templateEnvelopeId,
        paused: input.paused,
        userId: ctx.user.id,
      }),
  ),
});
