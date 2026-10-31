import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

// REVALLE: troca de conta pelo Financeiro (Fase 6): aviso ao remetente e aos destinatários das duas versões da NF.
const REVALLE_SEND_FINANCE_ACCOUNT_CHANGED_EMAIL_JOB_DEFINITION_ID = 'send.revalle.finance.account.changed.email';

const REVALLE_SEND_FINANCE_ACCOUNT_CHANGED_EMAIL_JOB_DEFINITION_SCHEMA = z.object({
  oldEnvelopeId: z.string(),
  newEnvelopeId: z.string(),
});

export type TRevalleSendFinanceAccountChangedEmailJobDefinition = z.infer<
  typeof REVALLE_SEND_FINANCE_ACCOUNT_CHANGED_EMAIL_JOB_DEFINITION_SCHEMA
>;

export const REVALLE_SEND_FINANCE_ACCOUNT_CHANGED_EMAIL_JOB_DEFINITION = {
  id: REVALLE_SEND_FINANCE_ACCOUNT_CHANGED_EMAIL_JOB_DEFINITION_ID,
  name: 'Revalle Send Finance Account Changed Email',
  version: '1.0.0',
  trigger: {
    name: REVALLE_SEND_FINANCE_ACCOUNT_CHANGED_EMAIL_JOB_DEFINITION_ID,
    schema: REVALLE_SEND_FINANCE_ACCOUNT_CHANGED_EMAIL_JOB_DEFINITION_SCHEMA,
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./revalle-send-finance-account-changed-email.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof REVALLE_SEND_FINANCE_ACCOUNT_CHANGED_EMAIL_JOB_DEFINITION_ID,
  TRevalleSendFinanceAccountChangedEmailJobDefinition
>;
