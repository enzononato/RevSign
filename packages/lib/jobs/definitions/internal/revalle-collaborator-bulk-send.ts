import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

// REVALLE (v.21): contrato para colaboradores. Cria os documentos de uma planilha na fila de envio em lotes. O payload
// leva só o id da planilha: as linhas (nome e e-mail) ficam no banco, porque o payload do job vai para o log.
const REVALLE_COLLABORATOR_BULK_SEND_JOB_DEFINITION_ID = 'internal.revalle-collaborator-bulk-send';

const REVALLE_COLLABORATOR_BULK_SEND_JOB_DEFINITION_SCHEMA = z.object({
  uploadId: z.string(),
});

export type TRevalleCollaboratorBulkSendJobDefinition = z.infer<
  typeof REVALLE_COLLABORATOR_BULK_SEND_JOB_DEFINITION_SCHEMA
>;

export const REVALLE_COLLABORATOR_BULK_SEND_JOB_DEFINITION = {
  id: REVALLE_COLLABORATOR_BULK_SEND_JOB_DEFINITION_ID,
  name: 'Revalle Collaborator Bulk Send',
  version: '1.0.0',
  trigger: {
    name: REVALLE_COLLABORATOR_BULK_SEND_JOB_DEFINITION_ID,
    schema: REVALLE_COLLABORATOR_BULK_SEND_JOB_DEFINITION_SCHEMA,
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./revalle-collaborator-bulk-send.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof REVALLE_COLLABORATOR_BULK_SEND_JOB_DEFINITION_ID,
  TRevalleCollaboratorBulkSendJobDefinition
>;
