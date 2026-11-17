import { findRevalleRecipientAccountName } from '@documenso/lib/server-only/revalle/recipients/account-name';

import { authenticatedProcedure } from '../trpc';
import {
  ZRecipientAccountNameRequestSchema,
  ZRecipientAccountNameResponseSchema,
} from './recipient-account-name.types';

/** Nome da conta do e-mail digitado no editor ("Conta: {nome}"). Só para quem é do time; com limite de consultas. */
export const recipientAccountNameRoute = authenticatedProcedure
  .input(ZRecipientAccountNameRequestSchema)
  .output(ZRecipientAccountNameResponseSchema)
  .query(
    async ({ input, ctx }) =>
      await findRevalleRecipientAccountName({
        userId: ctx.user.id,
        teamId: ctx.teamId,
        email: input.email,
        requestMetadata: ctx.metadata.requestMetadata,
      }),
  );
