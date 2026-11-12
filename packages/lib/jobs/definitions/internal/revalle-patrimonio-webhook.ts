import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

// REVALLE: integração com o Patrimônio. Entrega um aviso (webhook) ao Patrimônio. O payload leva só o id do aviso: o
// handler relê a linha (o log do job mostra o payload).
const REVALLE_PATRIMONIO_WEBHOOK_JOB_DEFINITION_ID = 'internal.revalle-patrimonio-webhook';

const REVALLE_PATRIMONIO_WEBHOOK_JOB_DEFINITION_SCHEMA = z.object({
  eventId: z.string().min(1).max(100),
});

export type TRevallePatrimonioWebhookJobDefinition = z.infer<typeof REVALLE_PATRIMONIO_WEBHOOK_JOB_DEFINITION_SCHEMA>;

export const REVALLE_PATRIMONIO_WEBHOOK_JOB_DEFINITION = {
  id: REVALLE_PATRIMONIO_WEBHOOK_JOB_DEFINITION_ID,
  name: 'Revalle Patrimonio Webhook',
  version: '1.0.0',
  trigger: {
    name: REVALLE_PATRIMONIO_WEBHOOK_JOB_DEFINITION_ID,
    schema: REVALLE_PATRIMONIO_WEBHOOK_JOB_DEFINITION_SCHEMA,
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./revalle-patrimonio-webhook.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof REVALLE_PATRIMONIO_WEBHOOK_JOB_DEFINITION_ID,
  TRevallePatrimonioWebhookJobDefinition
>;
