import { buildCollaboratorDocuments } from '../../../server-only/revalle/collaborator-contract/build-documents';
import type { JobRunIO } from '../../client/_internal/job';
import type { TRevalleCollaboratorContractBuildJobDefinition } from './revalle-collaborator-contract-build';

// REVALLE (v.22): contrato para colaboradores. Idempotente: rodar de novo continua de onde parou (só contagens no log).
export const run = async ({
  payload,
  io,
}: {
  payload: TRevalleCollaboratorContractBuildJobDefinition;
  io: JobRunIO;
}) => {
  const result = await buildCollaboratorDocuments({ contractId: payload.contractId });

  io.logger.info(`Collaborator contract build ${payload.contractId}: ${result}`);
};
