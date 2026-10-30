import { updateAccountingSettings } from '@documenso/lib/server-only/revalle/invoice/settings';

import { adminProcedure } from '../../trpc';
import { ZAdminUpdateSettingsRequestSchema, ZAdminUpdateSettingsResponseSchema } from './admin-update-settings.types';

export const adminUpdateSettingsRoute = adminProcedure
  .input(ZAdminUpdateSettingsRequestSchema)
  .output(ZAdminUpdateSettingsResponseSchema)
  .mutation(async ({ input, ctx }) => {
    await updateAccountingSettings({
      prompt: input.prompt,
      accountingEmail: input.accountingEmail || null,
      userId: ctx.user.id,
    });
  });
