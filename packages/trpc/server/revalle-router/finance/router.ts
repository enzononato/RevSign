import { router } from '../../trpc';
import { adminListFinanceUsersRoute } from './admin-list-users';
import { adminSetFinanceMemberRoute } from './admin-set-member';
import { approveFinanceAccountRoute } from './approve';
import { defineFinanceAccountRoute } from './define-account';
import { financeMeRoute } from './me';

export const financeRouter = router({
  adminListUsers: adminListFinanceUsersRoute,
  adminSetMember: adminSetFinanceMemberRoute,
  approve: approveFinanceAccountRoute,
  defineAccount: defineFinanceAccountRoute,
  me: financeMeRoute,
});
