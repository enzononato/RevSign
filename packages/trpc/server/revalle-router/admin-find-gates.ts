import { findLockedRevalleGates, findRevalleEmailLinks } from '@documenso/lib/server-only/revalle/gate/admin';

import { adminProcedure } from '../trpc';
import { ZAdminFindGatesRequestSchema, ZAdminFindGatesResponseSchema } from './admin-find-gates.types';

export const adminFindGatesRoute = adminProcedure
  .input(ZAdminFindGatesRequestSchema)
  .output(ZAdminFindGatesResponseSchema)
  .query(async ({ input }) => {
    if (input.type === 'LOCKED') {
      const { items, nextCursor } = await findLockedRevalleGates(input);

      return { locked: items, links: [], nextCursor };
    }

    const { items, nextCursor } = await findRevalleEmailLinks(input);

    return { locked: [], links: items, nextCursor };
  });
