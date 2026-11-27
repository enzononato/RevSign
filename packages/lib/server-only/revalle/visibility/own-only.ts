import { prisma, sql } from '@documenso/prisma';
import type { DB } from '@documenso/prisma/generated/types';
import { EnvelopeType, type Prisma } from '@prisma/client';
import type { Expression, ExpressionBuilder, SqlBool } from 'kysely';

import { isAdmin } from '../../../utils/is-admin';

/**
 * REVALLE (v.26): "Ver só o que enviou ou recebeu para assinar".
 *
 * Quem tem a marca (`RevalleUserVisibility.ownOnly`) só enxerga, em qualquer time, os documentos de que é dono ou em
 * que o e-mail da conta é destinatário. O admin do sistema nunca é limitado. Modelos (TEMPLATE) não são documentos e
 * continuam seguindo só a regra do time.
 *
 * Devolve `null` quando não há limite (sem a marca, admin ou conta inexistente) e, com a marca, o id e o e-mail da
 * conta para montar o filtro.
 */
export type RevalleOwnOnlyScope = { userId: number; email: string };

export const getRevalleOwnOnlyScope = async (userId: number): Promise<RevalleOwnOnlyScope | null> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, roles: true, revalleVisibility: { select: { ownOnly: true } } },
  });

  if (!user || isAdmin(user) || !user.revalleVisibility?.ownOnly) {
    return null;
  }

  return { userId: user.id, email: user.email };
};

/**
 * Filtro Prisma: dono OU destinatário (e-mail da conta). Modelos passam (`type = TEMPLATE`), para que um `where` sem
 * tipo fixo (type null) não esconda os modelos do time.
 */
export const revalleOwnOnlyPrismaWhere = (scope: RevalleOwnOnlyScope): Prisma.EnvelopeWhereInput => ({
  OR: [{ type: EnvelopeType.TEMPLATE }, { userId: scope.userId }, { recipients: { some: { email: scope.email } } }],
});

/** Mesmo filtro em Kysely, para os finders que montam a consulta na mão (lista, contadores). */
export const revalleOwnOnlyKyselyWhere = (
  eb: ExpressionBuilder<DB, 'Envelope'>,
  scope: RevalleOwnOnlyScope,
): Expression<SqlBool> =>
  eb.or([
    eb('Envelope.type', '=', sql.lit(EnvelopeType.TEMPLATE)),
    eb('Envelope.userId', '=', scope.userId),
    eb.exists(
      eb
        .selectFrom('Recipient')
        .whereRef('Recipient.envelopeId', '=', 'Envelope.id')
        .where('Recipient.email', '=', scope.email)
        .select(sql.lit(1).as('one')),
    ),
  ]);

/**
 * Para as rotas que checam só o time (arquivos e download por id): com a marca, o documento precisa ser da pessoa ou
 * tê-la como destinatária. Sem a marca (ou admin, ou modelo) devolve true e a regra de cima decide.
 */
export const isEnvelopeAllowedByRevalleOwnOnly = async ({
  userId,
  envelopeId,
}: {
  userId: number;
  envelopeId: string;
}): Promise<boolean> => {
  const scope = await getRevalleOwnOnlyScope(userId);

  if (!scope) {
    return true;
  }

  const allowed = await prisma.envelope.count({
    where: { id: envelopeId, ...revalleOwnOnlyPrismaWhere(scope) },
  });

  return allowed > 0;
};
