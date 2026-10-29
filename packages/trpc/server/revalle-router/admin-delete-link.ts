import { deleteRevalleEmailLink } from '@documenso/lib/server-only/revalle/gate/admin';

import { adminProcedure } from '../trpc';
import { ZAdminDeleteLinkRequestSchema, ZAdminDeleteLinkResponseSchema } from './admin-delete-link.types';

export const adminDeleteLinkRoute = adminProcedure
  .input(ZAdminDeleteLinkRequestSchema)
  .output(ZAdminDeleteLinkResponseSchema)
  .mutation(async ({ input, ctx }) => {
    await deleteRevalleEmailLink({
      linkId: input.linkId,
      admin: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name },
    });
  });
