import { router } from '../../trpc';
import { adminSetAccountingMemberRoute } from './admin-set-member';
import { accountingMeRoute } from './me';

export const accountingRouter = router({
  adminSetMember: adminSetAccountingMemberRoute,
  me: accountingMeRoute,
});
