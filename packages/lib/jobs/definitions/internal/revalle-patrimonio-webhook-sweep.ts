import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

// REVALLE: integração com o Patrimônio. Varredura dos avisos não entregues cuja próxima tentativa já venceu (ex.: o app
// reiniciou durante a espera entre tentativas).
const REVALLE_PATRIMONIO_WEBHOOK_SWEEP_JOB_DEFINITION_ID = 'internal.revalle-patrimonio-webhook-sweep';

const REVALLE_PATRIMONIO_WEBHOOK_SWEEP_JOB_DEFINITION_SCHEMA = z.object({});

export type TRevallePatrimonioWebhookSweepJobDefinition = z.infer<
  typeof REVALLE_PATRIMONIO_WEBHOOK_SWEEP_JOB_DEFINITION_SCHEMA
>;

export const REVALLE_PATRIMONIO_WEBHOOK_SWEEP_JOB_DEFINITION = {
  id: REVALLE_PATRIMONIO_WEBHOOK_SWEEP_JOB_DEFINITION_ID,
  name: 'Revalle Patrimonio Webhook Sweep',
  version: '1.0.0',
  trigger: {
    name: REVALLE_PATRIMONIO_WEBHOOK_SWEEP_JOB_DEFINITION_ID,
    schema: REVALLE_PATRIMONIO_WEBHOOK_SWEEP_JOB_DEFINITION_SCHEMA,
    cron: '*/15 * * * *', // Every 15 minutes.
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./revalle-patrimonio-webhook-sweep.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof REVALLE_PATRIMONIO_WEBHOOK_SWEEP_JOB_DEFINITION_ID,
  TRevallePatrimonioWebhookSweepJobDefinition
>;
