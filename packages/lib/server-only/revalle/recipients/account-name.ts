import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { normalizeEmail } from '../../../revalle/email-domain';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { buildTeamWhereQuery } from '../../../utils/teams';
import { createRateLimit } from '../../rate-limit/rate-limit';
import { assertRateLimit } from '../../rate-limit/rate-limit-middleware';

// O editor consulta a cada e-mail digitado (com espera de 400 ms): folga larga para quem monta envios, mas não para varrer
// a lista de contas.
const accountNameRateLimit = createRateLimit({ action: 'revalle.recipient-account-name', max: 300, window: '15m' });

/**
 * Nome da conta do e-mail, para a dica "Conta: {nome}" do editor. Só para quem é do time (o mesmo alcance da busca de
 * destinatários, que já mostra nomes de contas). `null` quando não há conta ou a conta não tem nome.
 */
export const findRevalleRecipientAccountName = async ({
  userId,
  teamId,
  email,
  requestMetadata,
}: {
  userId: number;
  teamId: number;
  email: string;
  requestMetadata: RequestMetadata;
}): Promise<{ name: string | null }> => {
  assertRateLimit(
    await accountNameRateLimit.check({ ip: requestMetadata.ipAddress ?? 'unknown', identifier: `user:${userId}` }),
  );

  const team = await prisma.team.findFirst({ where: buildTeamWhereQuery({ teamId, userId }), select: { id: true } });

  if (!team) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, { message: 'Você não faz parte deste time.' });
  }

  const normalized = normalizeEmail(email);

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    return { name: null };
  }

  const account = await prisma.user.findFirst({
    where: { email: { equals: normalized, mode: 'insensitive' } },
    select: { name: true },
  });

  return { name: account?.name?.trim() || null };
};
