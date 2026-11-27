import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

// REVALLE (v.26): inativação pela folha. Toda noite às 03:00 desativa as contas com CPF vinculado que a base do RH mostra
// como desligadas (pula quem o TI marcou "Mantido ativo"). Base do RH fora do ar: não faz nada naquela noite.
const REVALLE_HR_INACTIVATION_SWEEP_JOB_DEFINITION_ID = 'internal.revalle-hr-inactivation-sweep';

const REVALLE_HR_INACTIVATION_SWEEP_JOB_DEFINITION_SCHEMA = z.object({});

export type TRevalleHrInactivationSweepJobDefinition = z.infer<
  typeof REVALLE_HR_INACTIVATION_SWEEP_JOB_DEFINITION_SCHEMA
>;

export const REVALLE_HR_INACTIVATION_SWEEP_JOB_DEFINITION = {
  id: REVALLE_HR_INACTIVATION_SWEEP_JOB_DEFINITION_ID,
  name: 'Revalle HR Inactivation Sweep',
  version: '1.0.0',
  trigger: {
    name: REVALLE_HR_INACTIVATION_SWEEP_JOB_DEFINITION_ID,
    schema: REVALLE_HR_INACTIVATION_SWEEP_JOB_DEFINITION_SCHEMA,
    cron: '0 3 * * *', // Every day at 03:00.
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./revalle-hr-inactivation-sweep.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof REVALLE_HR_INACTIVATION_SWEEP_JOB_DEFINITION_ID,
  TRevalleHrInactivationSweepJobDefinition
>;
