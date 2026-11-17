import { prisma } from '@documenso/prisma';

import { runInvoiceFileRead } from '../../../server-only/revalle/invoice/suggest';
import type { JobRunIO } from '../../client/_internal/job';
import type { TRevalleInvoiceSuggestJobDefinition } from './revalle-invoice-suggest';

// REVALLE: nunca lança. Qualquer falha vira FAILED com um código curto (o job não é repetido e a tela não trava).
// Fase 9: um job por arquivo de nota. Job de antes da Fase 9 (sem `envelopeItemId`) sai sem fazer nada.
export const run = async ({ payload, io: _io }: { payload: TRevalleInvoiceSuggestJobDefinition; io: JobRunIO }) => {
  if (!payload.envelopeItemId) {
    return;
  }

  const file = await prisma.revalleInvoiceFile
    .findUnique({ where: { envelopeItemId: payload.envelopeItemId }, select: { id: true, envelopeId: true } })
    .catch(() => null);

  if (!file || file.envelopeId !== payload.envelopeId) {
    return;
  }

  await runInvoiceFileRead({
    fileId: file.id,
    fileSha256: payload.fileSha256,
    force: payload.force,
    attempt: payload.attempt,
  });
};
