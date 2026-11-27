import { router } from '../../trpc';
import { revalleReactivateUserRoute } from './reactivate';
import { revalleSetKeepActiveRoute } from './set-keep-active';
import { revalleUserStatusRoute } from './status';

/** REVALLE (v.26): situação da conta na tela "Usuários" do painel (inativação pela folha). */
export const revalleUsersRouter = router({
  status: revalleUserStatusRoute,
  reactivate: revalleReactivateUserRoute,
  setKeepActive: revalleSetKeepActiveRoute,
});
