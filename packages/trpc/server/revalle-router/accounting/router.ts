import { router } from '../../trpc';
import { adminSetAccountingMemberRoute } from './admin-set-member';
import { changeCostCenterRoute } from './change-cost-center';
import { defineCostCenterRoute } from './define-cost-center';
import { getAccountingCardRoute } from './get';
import { accountingMeRoute } from './me';
import { validateCostCenterRoute } from './validate';

export const accountingRouter = router({
  adminSetMember: adminSetAccountingMemberRoute,
  changeCostCenter: changeCostCenterRoute,
  defineCostCenter: defineCostCenterRoute,
  get: getAccountingCardRoute,
  me: accountingMeRoute,
  validate: validateCostCenterRoute,
});
