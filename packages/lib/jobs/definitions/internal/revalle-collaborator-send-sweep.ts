import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

// REVALLE (v.21): contrato para colaboradores. Varredura da fila de envio em lotes: a cada 15 minutos envia até
// `NEXT_PRIVATE_REVALLE_BULK_SEND_PER_HOUR / 4` documentos (padrão 25), sem estourar o SMTP.
const REVALLE_COLLABORATOR_SEND_SWEEP_JOB_DEFINITION_ID = 'internal.revalle-collaborator-send-sweep';

const REVALLE_COLLABORATOR_SEND_SWEEP_JOB_DEFINITION_SCHEMA = z.object({});

export type TRevalleCollaboratorSendSweepJobDefinition = z.infer<
  typeof REVALLE_COLLABORATOR_SEND_SWEEP_JOB_DEFINITION_SCHEMA
>;

export const REVALLE_COLLABORATOR_SEND_SWEEP_JOB_DEFINITION = {
  id: REVALLE_COLLABORATOR_SEND_SWEEP_JOB_DEFINITION_ID,
  name: 'Revalle Collaborator Send Sweep',
  version: '1.0.0',
  trigger: {
    name: REVALLE_COLLABORATOR_SEND_SWEEP_JOB_DEFINITION_ID,
    schema: REVALLE_COLLABORATOR_SEND_SWEEP_JOB_DEFINITION_SCHEMA,
    cron: '*/15 * * * *', // Every 15 minutes.
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./revalle-collaborator-send-sweep.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof REVALLE_COLLABORATOR_SEND_SWEEP_JOB_DEFINITION_ID,
  TRevalleCollaboratorSendSweepJobDefinition
>;
