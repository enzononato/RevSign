import { getRevalleEmailLinkStatus } from '@documenso/lib/server-only/revalle/recipient-suggestions';

import { authenticatedProcedure } from '../trpc';
import { ZRecipientLinkStatusRequestSchema, ZRecipientLinkStatusResponseSchema } from './recipient-link-status.types';

export const recipientLinkStatusRoute = authenticatedProcedure
  .input(ZRecipientLinkStatusRequestSchema)
  .output(ZRecipientLinkStatusResponseSchema)
  .query(async ({ input }) => await getRevalleEmailLinkStatus(input.emails));
