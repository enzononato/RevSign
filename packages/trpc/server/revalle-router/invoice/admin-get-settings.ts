import { getAccountingSettings, getRevalleInvoiceAiConfig } from '@documenso/lib/server-only/revalle/invoice/settings';

import { adminProcedure } from '../../trpc';
import { ZAdminGetSettingsRequestSchema, ZAdminGetSettingsResponseSchema } from './admin-get-settings.types';

export const adminGetSettingsRoute = adminProcedure
  .input(ZAdminGetSettingsRequestSchema)
  .output(ZAdminGetSettingsResponseSchema)
  .query(async () => {
    const settings = await getAccountingSettings();
    const { status, model } = getRevalleInvoiceAiConfig();

    return { ...settings, aiStatus: status, model };
  });
