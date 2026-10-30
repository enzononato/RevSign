import { router } from '../../trpc';
import { adminListFinanceUsersRoute } from './admin-list-users';
import { adminSetFinanceMemberRoute } from './admin-set-member';
import { financeMeRoute } from './me';

export const financeRouter = router({
  adminListUsers: adminListFinanceUsersRoute,
  adminSetMember: adminSetFinanceMemberRoute,
  me: financeMeRoute,
});
