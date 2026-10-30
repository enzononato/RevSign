import { router } from '../../trpc';
import { adminFindAccountsRoute } from './admin-find-accounts';
import { adminGetSettingsRoute } from './admin-get-settings';
import { adminImportAccountsRoute } from './admin-import-accounts';
import { adminPreviewAccountsRoute } from './admin-preview-accounts';
import { adminUpdateSettingsRoute } from './admin-update-settings';

export const invoiceRouter = router({
  adminPreviewAccounts: adminPreviewAccountsRoute,
  adminImportAccounts: adminImportAccountsRoute,
  adminFindAccounts: adminFindAccountsRoute,
  adminGetSettings: adminGetSettingsRoute,
  adminUpdateSettings: adminUpdateSettingsRoute,
});
