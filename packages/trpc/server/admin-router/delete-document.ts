import { adminSuperDeleteDocument } from '@documenso/lib/server-only/admin/admin-super-delete-document';
import { sendDeleteEmail } from '@documenso/lib/server-only/document/send-delete-email';
import { assertNotPatrimonioTermo } from '@documenso/lib/server-only/revalle/patrimonio/guard'; // REVALLE:

import { adminProcedure } from '../trpc';
import { ZDeleteDocumentRequestSchema, ZDeleteDocumentResponseSchema } from './delete-document.types';

export const deleteDocumentRoute = adminProcedure
  .input(ZDeleteDocumentRequestSchema)
  .output(ZDeleteDocumentResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { id, reason } = input;

    ctx.logger.info({
      input: {
        id,
      },
    });

    await assertNotPatrimonioTermo(id, { action: 'delete' }); // REVALLE: antes do e-mail de exclusão

    await sendDeleteEmail({ envelopeId: id, reason });

    await adminSuperDeleteDocument({
      envelopeId: id,
      requestMetadata: ctx.metadata.requestMetadata,
    });
  });
