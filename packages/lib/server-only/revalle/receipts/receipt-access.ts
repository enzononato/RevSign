import { prisma } from '@documenso/prisma';
import { EnvelopeType, type Role } from '@prisma/client';

import { isAdmin } from '../../../utils/is-admin';
import { getEnvelopeWhereInput } from '../../envelope/get-envelope-by-id';
import { getTeamByUrl } from '../../team/get-team';

// REVALLE: quem vê a página do documento vê os comprovantes: o dono, quem é do time (com a mesma regra de visibilidade
// da página) e o admin. Qualquer outro caso = nulo (a rota responde 404, sem dizer se o documento existe).

const envelopeSelect = { id: true, title: true, team: { select: { url: true } } } as const;

export type ReceiptEnvelope = { id: string; title: string; team: { url: string } };

export const getReceiptEnvelopeForUser = async ({
  user,
  teamUrl,
  envelopeId,
}: {
  user: { id: number; roles: Role[] };
  teamUrl: string;
  envelopeId: string;
}): Promise<ReceiptEnvelope | null> => {
  const fromTeam = await (async () => {
    try {
      const team = await getTeamByUrl({ userId: user.id, teamUrl });

      const { envelopeWhereInput } = await getEnvelopeWhereInput({
        id: { type: 'envelopeId', id: envelopeId },
        type: EnvelopeType.DOCUMENT,
        userId: user.id,
        teamId: team.id,
      });

      return await prisma.envelope.findUnique({ where: envelopeWhereInput, select: envelopeSelect });
    } catch {
      return null;
    }
  })();

  if (fromTeam) {
    return fromTeam;
  }

  if (!isAdmin(user)) {
    return null;
  }

  return await prisma.envelope.findFirst({
    where: { id: envelopeId, type: EnvelopeType.DOCUMENT, team: { url: teamUrl } },
    select: envelopeSelect,
  });
};
