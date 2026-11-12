import { sweepPatrimonioEvents } from '../../../server-only/revalle/patrimonio/deliver';
import type { JobRunIO } from '../../client/_internal/job';
import type { TRevallePatrimonioWebhookSweepJobDefinition } from './revalle-patrimonio-webhook-sweep';

// REVALLE: integração com o Patrimônio. Reagenda os avisos com a tentativa vencida.
export const run = async ({ io }: { payload: TRevallePatrimonioWebhookSweepJobDefinition; io: JobRunIO }) => {
  const count = await sweepPatrimonioEvents();

  if (count > 0) {
    io.logger.info(`Patrimonio webhook sweep: ${count} aviso(s) reagendado(s)`);
  }
};
