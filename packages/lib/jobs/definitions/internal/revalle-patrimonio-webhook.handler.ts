import { deliverPatrimonioEvent } from '../../../server-only/revalle/patrimonio/deliver';
import type { JobRunIO } from '../../client/_internal/job';
import type { TRevallePatrimonioWebhookJobDefinition } from './revalle-patrimonio-webhook';

// REVALLE: integração com o Patrimônio. Uma tentativa de entrega; as próximas são agendadas pela própria entrega.
export const run = async ({ payload, io }: { payload: TRevallePatrimonioWebhookJobDefinition; io: JobRunIO }) => {
  const result = await deliverPatrimonioEvent(payload.eventId);

  io.logger.info(`Patrimonio webhook ${payload.eventId}: ${result}`);
};
