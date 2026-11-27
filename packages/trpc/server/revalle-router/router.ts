import { router } from '../trpc';
import { acceptTermRoute } from './accept-term';
import { accountingRouter } from './accounting/router';
import { adminDeleteLinkRoute } from './admin-delete-link';
import { adminFindGatesRoute } from './admin-find-gates';
import { adminUnlockGateRoute } from './admin-unlock-gate';
import { collaboratorContractRouter } from './collaborator-contract/router';
import { confirmIdentityRoute } from './confirm-identity';
import { financeRouter } from './finance/router';
import { invoiceRouter } from './invoice/router';
import { recipientAccountNameRoute } from './recipient-account-name';
import { recipientLinkStatusRoute } from './recipient-link-status';
import { unitsRouter } from './units/router';
import { verifyIdentityRoute } from './verify-identity';

export const revalleRouter = router({
  gate: router({
    acceptTerm: acceptTermRoute,
    verifyIdentity: verifyIdentityRoute,
    confirmIdentity: confirmIdentityRoute,
  }),
  recipientLinkStatus: recipientLinkStatusRoute,
  recipients: router({
    accountName: recipientAccountNameRoute,
  }),
  admin: router({
    findGates: adminFindGatesRoute,
    unlockGate: adminUnlockGateRoute,
    deleteLink: adminDeleteLinkRoute,
  }),
  invoice: invoiceRouter,
  finance: financeRouter,
  accounting: accountingRouter,
  collaboratorContract: collaboratorContractRouter,
  units: unitsRouter,
});
