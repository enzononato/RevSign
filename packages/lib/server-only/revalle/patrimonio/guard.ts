// REVALLE: integração com o Patrimônio. Termo do Patrimônio só muda pelas rotas da integração: excluir, reenviar,
// mexer em destinatário, campo, arquivo ou dados, duplicar ou virar modelo pela tela, pela API comum ou pelo admin é
// recusado (cancelar pela tela continua possível). Assim a linha do termo, a trilha de auditoria e os avisos ficam
// consistentes, e um termo vencido continua vencido.

import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';

import { AppError } from '../../../errors/app-error';

export const PATRIMONIO_TERMO_LOCKED_CODE = 'PATRIMONIO_TERMO_LOCKED';

export const PATRIMONIO_TERMO_DELETE_MESSAGE = 'Este termo é do Patrimônio: cancele pelo sistema do Patrimônio.';

export const PATRIMONIO_TERMO_CHANGE_MESSAGE =
  'Este termo é do Patrimônio: reenvie, altere ou cancele pelo sistema do Patrimônio.';

export const isPatrimonioTermoEnvelope = async (
  envelopeId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<boolean> =>
  (await tx.revallePatrimonioTermo.findUnique({ where: { envelopeId }, select: { envelopeId: true } })) !== null;

/** Recusa (400, `PATRIMONIO_TERMO_LOCKED`) quando o envelope é um termo do Patrimônio. */
export const assertNotPatrimonioTermo = async (
  envelopeId: string,
  { action = 'change', tx = prisma }: { action?: 'delete' | 'change'; tx?: Prisma.TransactionClient } = {},
): Promise<void> => {
  if (!(await isPatrimonioTermoEnvelope(envelopeId, tx))) {
    return;
  }

  const message = action === 'delete' ? PATRIMONIO_TERMO_DELETE_MESSAGE : PATRIMONIO_TERMO_CHANGE_MESSAGE;

  throw new AppError(PATRIMONIO_TERMO_LOCKED_CODE, { message, userMessage: message, statusCode: 400 });
};
