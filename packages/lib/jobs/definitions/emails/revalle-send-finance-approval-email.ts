import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

// REVALLE: selagem retida (Fase 6): aviso aos membros do Financeiro de que uma NF assinada espera a aprovação.
const REVALLE_SEND_FINANCE_APPROVAL_EMAIL_JOB_DEFINITION_ID = 'send.revalle.finance.approval.email';

const REVALLE_SEND_FINANCE_APPROVAL_EMAIL_JOB_DEFINITION_SCHEMA = z.object({
  envelopeId: z.string(),
});

export type TRevalleSendFinanceApprovalEmailJobDefinition = z.infer<
  typeof REVALLE_SEND_FINANCE_APPROVAL_EMAIL_JOB_DEFINITION_SCHEMA
>;

export const REVALLE_SEND_FINANCE_APPROVAL_EMAIL_JOB_DEFINITION = {
  id: REVALLE_SEND_FINANCE_APPROVAL_EMAIL_JOB_DEFINITION_ID,
  name: 'Revalle Send Finance Approval Email',
  version: '1.0.0',
  trigger: {
    name: REVALLE_SEND_FINANCE_APPROVAL_EMAIL_JOB_DEFINITION_ID,
    schema: REVALLE_SEND_FINANCE_APPROVAL_EMAIL_JOB_DEFINITION_SCHEMA,
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./revalle-send-finance-approval-email.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof REVALLE_SEND_FINANCE_APPROVAL_EMAIL_JOB_DEFINITION_ID,
  TRevalleSendFinanceApprovalEmailJobDefinition
>;
