import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

// REVALLE: e-mail para a contabilidade quando uma nota fiscal é concluída (Fase 5).
const REVALLE_SEND_INVOICE_ACCOUNTING_EMAIL_JOB_DEFINITION_ID = 'send.revalle.invoice.accounting.email';

const REVALLE_SEND_INVOICE_ACCOUNTING_EMAIL_JOB_DEFINITION_SCHEMA = z.object({
  envelopeId: z.string(),
});

export type TRevalleSendInvoiceAccountingEmailJobDefinition = z.infer<
  typeof REVALLE_SEND_INVOICE_ACCOUNTING_EMAIL_JOB_DEFINITION_SCHEMA
>;

export const REVALLE_SEND_INVOICE_ACCOUNTING_EMAIL_JOB_DEFINITION = {
  id: REVALLE_SEND_INVOICE_ACCOUNTING_EMAIL_JOB_DEFINITION_ID,
  name: 'Revalle Send Invoice Accounting Email',
  version: '1.0.0',
  trigger: {
    name: REVALLE_SEND_INVOICE_ACCOUNTING_EMAIL_JOB_DEFINITION_ID,
    schema: REVALLE_SEND_INVOICE_ACCOUNTING_EMAIL_JOB_DEFINITION_SCHEMA,
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./revalle-send-invoice-accounting-email.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof REVALLE_SEND_INVOICE_ACCOUNTING_EMAIL_JOB_DEFINITION_ID,
  TRevalleSendInvoiceAccountingEmailJobDefinition
>;
