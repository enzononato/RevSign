import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { isAdmin } from '../../../utils/is-admin';
import { getEnvelopeWhereInput } from '../../envelope/get-envelope-by-id';

/**
 * Quem pode ver e mexer na classificação: o dono do documento, quem é do time com acesso a ele (mesma regra do
 * editor, `getEnvelopeWhereInput`, com o time do próprio documento) e o admin do sistema. Signatário não tem sessão
 * de editor e nunca passa. Sem acesso = 404 (não revela que o documento existe).
 */
export const assertInvoiceEnvelopeAccess = async ({ envelopeId, userId }: { envelopeId: string; userId: number }) => {
  const notFound = () => new AppError(AppErrorCode.NOT_FOUND, { message: 'Documento não encontrado.' });

  const envelope = await prisma.envelope.findUnique({ where: { id: envelopeId }, select: { id: true, teamId: true } });

  if (!envelope) {
    throw notFound();
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { roles: true } });

  if (!user) {
    throw notFound();
  }

  if (isAdmin(user)) {
    return;
  }

  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id: { type: 'envelopeId', id: envelopeId },
    userId,
    teamId: envelope.teamId,
    type: null,
  }).catch(() => {
    throw notFound();
  });

  const allowed = await prisma.envelope.findFirst({ where: envelopeWhereInput, select: { id: true } });

  if (!allowed) {
    throw notFound();
  }
};
