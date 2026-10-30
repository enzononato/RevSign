import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

// REVALLE: sugestão de conta contábil para nota fiscal (Fase 5). O payload nunca leva o conteúdo da NF: o handler
// relê o arquivo pelo envelope (o log do job mostra o payload).
const REVALLE_INVOICE_SUGGEST_JOB_DEFINITION_ID = 'internal.revalle-invoice-suggest';

const REVALLE_INVOICE_SUGGEST_JOB_DEFINITION_SCHEMA = z.object({
  envelopeId: z.string(),
  /** Chave do conjunto de arquivos no momento do pedido; se mudou, o resultado é descartado. */
  fileSha256: z.string(),
  /** "Sugerir de novo": ignora o cache e o substitui. */
  force: z.boolean(),
});

export type TRevalleInvoiceSuggestJobDefinition = z.infer<typeof REVALLE_INVOICE_SUGGEST_JOB_DEFINITION_SCHEMA>;

export const REVALLE_INVOICE_SUGGEST_JOB_DEFINITION = {
  id: REVALLE_INVOICE_SUGGEST_JOB_DEFINITION_ID,
  name: 'Revalle Invoice Suggest',
  version: '1.0.0',
  trigger: {
    name: REVALLE_INVOICE_SUGGEST_JOB_DEFINITION_ID,
    schema: REVALLE_INVOICE_SUGGEST_JOB_DEFINITION_SCHEMA,
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./revalle-invoice-suggest.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof REVALLE_INVOICE_SUGGEST_JOB_DEFINITION_ID,
  TRevalleInvoiceSuggestJobDefinition
>;
