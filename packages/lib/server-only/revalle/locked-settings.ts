import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { isAdmin } from '../../utils/is-admin';

export const REVALLE_ADMIN_ONLY_MESSAGE = 'Só o administrador pode alterar isso.';

/**
 * Campos de `team.settings.update` e `organisation.settings.update` que a tela de Lembretes ainda grava (validade do
 * link e lembretes). Todo o resto é de página escondida (marca, e-mail, documento, certificado, IA): só o admin do
 * sistema grava, para que a rota não fique aberta a quem sabe o endereço dela.
 */
const OPEN_SETTINGS_KEYS = new Set(['reminderSettings', 'envelopeExpirationPeriod']);

/**
 * Recusa quem não é admin do sistema. O papel vem do banco a cada chamada: a sessão pode ser anterior à promoção ou
 * ao rebaixamento.
 */
export const assertRevalleAdmin = async (userId: number): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { roles: true } });

  if (!user || !isAdmin(user)) {
    throw new AppError(AppErrorCode.FORBIDDEN, { message: REVALLE_ADMIN_ONLY_MESSAGE });
  }
};

/**
 * Guarda das duas rotas de configurações: o usuário comum só passa se o pedido mexer apenas nos campos de
 * `OPEN_SETTINGS_KEYS`. Campo `undefined` não conta (a tela de lembretes da organização manda `undefined` para o que
 * não mudou).
 */
export const assertRevalleSettingsAccess = async ({
  userId,
  data,
}: {
  userId: number;
  data: Record<string, unknown>;
}): Promise<void> => {
  const touchesLockedSetting = Object.entries(data).some(
    ([key, value]) => value !== undefined && !OPEN_SETTINGS_KEYS.has(key),
  );

  if (touchesLockedSetting) {
    await assertRevalleAdmin(userId);
  }
};
