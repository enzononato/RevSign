import { confirmRevalleIdentity } from '@documenso/lib/server-only/revalle/gate/confirm-identity';
import { findRevalleGateRecipient } from '@documenso/lib/server-only/revalle/gate/find-gate-recipient';
import { assertRevalleGateRateLimit } from '@documenso/lib/server-only/revalle/gate/rate-limit';

import { procedure } from '../trpc';
import { ZConfirmIdentityRequestSchema, ZConfirmIdentityResponseSchema } from './confirm-identity.types';

export const confirmIdentityRoute = procedure
  .input(ZConfirmIdentityRequestSchema)
  .output(ZConfirmIdentityResponseSchema)
  .mutation(async ({ input, ctx }) => {
    await assertRevalleGateRateLimit(ctx.metadata.requestMetadata);

    const recipient = await findRevalleGateRecipient(input.token);

    return await confirmRevalleIdentity({
      recipientId: recipient.id,
      isMe: input.isMe,
      requestMetadata: ctx.metadata.requestMetadata,
    });
  });
