import { router } from '../../trpc';
import { adminListFinanceUsersRoute } from './admin-list-users';
import { adminSetFinanceMemberRoute } from './admin-set-member';
import { defineFinanceAccountRoute } from './define-account';
import { financeMeRoute } from './me';

export const financeRouter = router({
  adminListUsers: adminListFinanceUsersRoute,
  adminSetMember: adminSetFinanceMemberRoute,
  defineAccount: defineFinanceAccountRoute,
  me: financeMeRoute,
});
