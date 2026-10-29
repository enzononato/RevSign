import { acceptRevalleTerm } from '@documenso/lib/server-only/revalle/gate/accept-term';
import { findRevalleGateRecipient } from '@documenso/lib/server-only/revalle/gate/find-gate-recipient';
import { assertRevalleGateRateLimit } from '@documenso/lib/server-only/revalle/gate/rate-limit';

import { procedure } from '../trpc';
import { ZAcceptTermRequestSchema, ZAcceptTermResponseSchema } from './accept-term.types';

export const acceptTermRoute = procedure
  .input(ZAcceptTermRequestSchema)
  .output(ZAcceptTermResponseSchema)
  .mutation(async ({ input, ctx }) => {
    await assertRevalleGateRateLimit(ctx.metadata.requestMetadata);

    const recipient = await findRevalleGateRecipient(input.token);

    return await acceptRevalleTerm({
      recipientId: recipient.id,
      termVersion: input.termVersion,
      requestMetadata: ctx.metadata.requestMetadata,
    });
  });
