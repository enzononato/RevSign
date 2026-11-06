import { findInvoiceDocumentTags } from '@documenso/lib/server-only/revalle/invoice/document-tags';

import { authenticatedProcedure } from '../../trpc';
import { ZInvoiceDocumentTagsRequestSchema, ZInvoiceDocumentTagsResponseSchema } from './document-tags.types';

/** Conta e centro de custo das NFs de uma página da lista de Documentos (só leitura). */
export const invoiceDocumentTagsRoute = authenticatedProcedure
  .input(ZInvoiceDocumentTagsRequestSchema)
  .output(ZInvoiceDocumentTagsResponseSchema)
  .query(async ({ input, ctx }) => {
    const { teamId, envelopeIds } = input;

    return await findInvoiceDocumentTags({ userId: ctx.user.id, teamId, envelopeIds });
  });
