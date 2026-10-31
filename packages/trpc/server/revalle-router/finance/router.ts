import { router } from '../../trpc';
import { adminListFinanceUsersRoute } from './admin-list-users';
import { adminSetFinanceMemberRoute } from './admin-set-member';
import { approveFinanceAccountRoute } from './approve';
import { changeFinanceAccountRoute } from './change-account';
import { defineFinanceAccountRoute } from './define-account';
import { getFinanceCardRoute } from './get';
import { financeMeRoute } from './me';

export const financeRouter = router({
  adminListUsers: adminListFinanceUsersRoute,
  adminSetMember: adminSetFinanceMemberRoute,
  approve: approveFinanceAccountRoute,
  changeAccount: changeFinanceAccountRoute,
  defineAccount: defineFinanceAccountRoute,
  get: getFinanceCardRoute,
  me: financeMeRoute,
});
