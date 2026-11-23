import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

// REVALLE (v.22): contrato para colaboradores pela página própria. Quando o representante assina, cria o modelo com as
// páginas assinadas e um documento por colaborador da lista, na fila de envio. O payload leva só o id do contrato.
const REVALLE_COLLABORATOR_CONTRACT_BUILD_JOB_DEFINITION_ID = 'internal.revalle-collaborator-contract-build';

const REVALLE_COLLABORATOR_CONTRACT_BUILD_JOB_DEFINITION_SCHEMA = z.object({
  contractId: z.string(),
});

export type TRevalleCollaboratorContractBuildJobDefinition = z.infer<
  typeof REVALLE_COLLABORATOR_CONTRACT_BUILD_JOB_DEFINITION_SCHEMA
>;

export const REVALLE_COLLABORATOR_CONTRACT_BUILD_JOB_DEFINITION = {
  id: REVALLE_COLLABORATOR_CONTRACT_BUILD_JOB_DEFINITION_ID,
  name: 'Revalle Collaborator Contract Build',
  version: '1.0.0',
  trigger: {
    name: REVALLE_COLLABORATOR_CONTRACT_BUILD_JOB_DEFINITION_ID,
    schema: REVALLE_COLLABORATOR_CONTRACT_BUILD_JOB_DEFINITION_SCHEMA,
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./revalle-collaborator-contract-build.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof REVALLE_COLLABORATOR_CONTRACT_BUILD_JOB_DEFINITION_ID,
  TRevalleCollaboratorContractBuildJobDefinition
>;
