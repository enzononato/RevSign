import { router } from '../../trpc';
import { adminFindAccountsRoute } from './admin-find-accounts';
import { adminGetSettingsRoute } from './admin-get-settings';
import { adminImportAccountsRoute } from './admin-import-accounts';
import { adminPreviewAccountsRoute } from './admin-preview-accounts';
import { adminUpdateSettingsRoute } from './admin-update-settings';
import { classifyInvoiceRoute } from './classify';
import { findInvoicesRoute } from './find';
import { findInvoiceAccountsRoute } from './find-accounts';
import { getInvoiceRoute } from './get';
import { markAsInvoiceRoute } from './mark-as-invoice';
import { resuggestInvoiceRoute } from './resuggest';
import { setInvoiceChoiceRoute } from './set-choice';
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
  setChoice: setInvoiceChoiceRoute,
  markAsInvoice: markAsInvoiceRoute,
  findAccounts: findInvoiceAccountsRoute,
  find: findInvoicesRoute,
});
