import { findRevalleGateRecipient } from '@documenso/lib/server-only/revalle/gate/find-gate-recipient';
import { assertRevalleGateRateLimit } from '@documenso/lib/server-only/revalle/gate/rate-limit';
import { verifyRevalleIdentity } from '@documenso/lib/server-only/revalle/gate/verify-identity';

import { procedure } from '../trpc';
import { ZVerifyIdentityRequestSchema, ZVerifyIdentityResponseSchema } from './verify-identity.types';

export const verifyIdentityRoute = procedure
  .input(ZVerifyIdentityRequestSchema)
  .output(ZVerifyIdentityResponseSchema)
  .mutation(async ({ input, ctx }) => {
    await assertRevalleGateRateLimit(ctx.metadata.requestMetadata);

    const recipient = await findRevalleGateRecipient(input.token);

    return await verifyRevalleIdentity({
      recipientId: recipient.id,
      cpf: input.cpf,
      birthDate: input.birthDate,
      requestMetadata: ctx.metadata.requestMetadata,
    });
  });
