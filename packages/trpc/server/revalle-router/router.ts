import { router } from '../trpc';
import { acceptTermRoute } from './accept-term';
import { adminDeleteLinkRoute } from './admin-delete-link';
import { adminFindGatesRoute } from './admin-find-gates';
import { adminUnlockGateRoute } from './admin-unlock-gate';
import { confirmIdentityRoute } from './confirm-identity';
import { financeRouter } from './finance/router';
import { invoiceRouter } from './invoice/router';
import { recipientLinkStatusRoute } from './recipient-link-status';
import { verifyIdentityRoute } from './verify-identity';

export const revalleRouter = router({
  gate: router({
    acceptTerm: acceptTermRoute,
    verifyIdentity: verifyIdentityRoute,
    confirmIdentity: confirmIdentityRoute,
  }),
  recipientLinkStatus: recipientLinkStatusRoute,
  admin: router({
    findGates: adminFindGatesRoute,
    unlockGate: adminUnlockGateRoute,
    deleteLink: adminDeleteLinkRoute,
  }),
  invoice: invoiceRouter,
  finance: financeRouter,
});
