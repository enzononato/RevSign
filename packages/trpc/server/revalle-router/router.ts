import { router } from '../trpc';
import { acceptTermRoute } from './accept-term';
import { confirmIdentityRoute } from './confirm-identity';
import { verifyIdentityRoute } from './verify-identity';

export const revalleRouter = router({
  gate: router({
    acceptTerm: acceptTermRoute,
    verifyIdentity: verifyIdentityRoute,
    confirmIdentity: confirmIdentityRoute,
  }),
});
