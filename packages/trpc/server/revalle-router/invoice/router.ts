import { router } from '../../trpc';
import { adminFindAccountsRoute } from './admin-find-accounts';
import { adminGetSettingsRoute } from './admin-get-settings';
import { adminImportAccountsRoute } from './admin-import-accounts';
import { adminPreviewAccountsRoute } from './admin-preview-accounts';
import { adminUpdateSettingsRoute } from './admin-update-settings';
import { classifyInvoiceRoute } from './classify';
import { getInvoiceRoute } from './get';
import { resuggestInvoiceRoute } from './resuggest';
import { setInvoiceFlagRoute } from './set-invoice-flag';

export const invoiceRouter = router({
  adminPreviewAccounts: adminPreviewAccountsRoute,
  adminImportAccounts: adminImportAccountsRoute,
  adminFindAccounts: adminFindAccountsRoute,
  adminGetSettings: adminGetSettingsRoute,
  adminUpdateSettings: adminUpdateSettingsRoute,
  get: getInvoiceRoute,
  classify: classifyInvoiceRoute,
  setInvoiceFlag: setInvoiceFlagRoute,
  resuggest: resuggestInvoiceRoute,
});
