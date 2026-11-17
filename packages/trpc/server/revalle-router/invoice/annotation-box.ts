import {
  deleteInvoiceAnnotationBox,
  findInvoiceAnnotationBoxesForUser,
  setInvoiceAnnotationBox,
} from '@documenso/lib/server-only/revalle/invoice/annotation-box';

import { authenticatedProcedure, router } from '../../trpc';
import {
  ZDeleteAnnotationBoxRequestSchema,
  ZDeleteAnnotationBoxResponseSchema,
  ZFindAnnotationBoxesRequestSchema,
  ZFindAnnotationBoxesResponseSchema,
  ZSetAnnotationBoxRequestSchema,
  ZSetAnnotationBoxResponseSchema,
} from './annotation-box.types';

/**
 * O bloco "Conta e centro de custo" do editor (um por arquivo). Mesma regra de edição dos campos: o envelope que a
 * pessoa abre no time da sessão, só em rascunho. Sem acesso ou arquivo de outro envelope: 404; já enviado: 400.
 */
export const annotationBoxRouter = router({
  find: authenticatedProcedure
    .input(ZFindAnnotationBoxesRequestSchema)
    .output(ZFindAnnotationBoxesResponseSchema)
    .query(async ({ input, ctx }) => ({
      boxes: await findInvoiceAnnotationBoxesForUser({
        userId: ctx.user.id,
        teamId: ctx.teamId,
        envelopeId: input.envelopeId,
      }),
    })),

  set: authenticatedProcedure
    .input(ZSetAnnotationBoxRequestSchema)
    .output(ZSetAnnotationBoxResponseSchema)
    .mutation(async ({ input, ctx }) =>
      setInvoiceAnnotationBox({
        userId: ctx.user.id,
        teamId: ctx.teamId,
        envelopeId: input.envelopeId,
        envelopeItemId: input.envelopeItemId,
        rect: input.rect,
      }),
    ),

  delete: authenticatedProcedure
    .input(ZDeleteAnnotationBoxRequestSchema)
    .output(ZDeleteAnnotationBoxResponseSchema)
    .mutation(async ({ input, ctx }) => {
      await deleteInvoiceAnnotationBox({
        userId: ctx.user.id,
        teamId: ctx.teamId,
        envelopeId: input.envelopeId,
        envelopeItemId: input.envelopeItemId,
      });

      return { ok: true as const };
    }),
});
