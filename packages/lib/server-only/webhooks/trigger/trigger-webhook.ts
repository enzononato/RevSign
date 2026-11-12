import type { WebhookTriggerEvents } from '@prisma/client';

import { jobs } from '../../../jobs/client';
import { queuePatrimonioTermoEvent } from '../../revalle/patrimonio/events'; // REVALLE:
import { getAllWebhooksByEventTrigger } from '../get-all-webhooks-by-event-trigger';

export type TriggerWebhookOptions = {
  event: WebhookTriggerEvents;
  data: Record<string, unknown>;
  userId: number;
  teamId: number;
};

export const triggerWebhook = async ({ event, data, userId, teamId }: TriggerWebhookOptions) => {
  // REVALLE: aviso ao Patrimônio quando o envelope é um termo dele (segundo plano; nunca lança nem segura).
  queuePatrimonioTermoEvent({ event, data });

  try {
    const registeredWebhooks = await getAllWebhooksByEventTrigger({ event, userId, teamId });

    if (registeredWebhooks.length === 0) {
      return;
    }

    await Promise.allSettled(
      registeredWebhooks.map(async (webhook) => {
        await jobs.triggerJob({
          name: 'internal.execute-webhook',
          payload: {
            event,
            webhookId: webhook.id,
            data,
          },
        });
      }),
    );
  } catch (err) {
    console.error(err);
    throw new Error(`Failed to trigger webhook`);
  }
};
