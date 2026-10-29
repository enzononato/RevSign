import { unlockRevalleGate } from '@documenso/lib/server-only/revalle/gate/admin';

import { adminProcedure } from '../trpc';
import { ZAdminUnlockGateRequestSchema, ZAdminUnlockGateResponseSchema } from './admin-unlock-gate.types';

export const adminUnlockGateRoute = adminProcedure
  .input(ZAdminUnlockGateRequestSchema)
  .output(ZAdminUnlockGateResponseSchema)
  .mutation(async ({ input, ctx }) => {
    await unlockRevalleGate({
      gateId: input.gateId,
      admin: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name },
      requestMetadata: ctx.metadata.requestMetadata,
    });
  });
