import { sweepCollaboratorSendQueue } from '../../../server-only/revalle/collaborator-contract/sweep';
import type { JobRunIO } from '../../client/_internal/job';
import type { TRevalleCollaboratorSendSweepJobDefinition } from './revalle-collaborator-send-sweep';

// REVALLE (v.21): contrato para colaboradores. Envia o próximo lote da fila (só contagens no log).
export const run = async ({ io }: { payload: TRevalleCollaboratorSendSweepJobDefinition; io: JobRunIO }) => {
  const { sent, retried, failed } = await sweepCollaboratorSendQueue();

  if (sent + retried + failed > 0) {
    io.logger.info(
      `Collaborator contract send sweep: ${sent} enviado(s), ${retried} de novo na fila, ${failed} falha(s)`,
    );
  }
};
