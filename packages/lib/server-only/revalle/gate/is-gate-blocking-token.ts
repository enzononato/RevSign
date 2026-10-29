import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { assertRevalleGatePassed } from './assert-gate-passed';

/**
 * Para as rotas de arquivo (Hono) que aceitam o token do destinatário: devolve `true` quando o portão do dono do token
 * ainda não foi concluído. Tokens `qr_` (compartilhamento de documento concluído) e token desconhecido não passam por aqui.
 */
export const isRevalleGateBlockingToken = async (
  token: string,
  requestMetadata?: RequestMetadata,
): Promise<boolean> => {
  if (token.startsWith('qr_')) {
    return false;
  }

  const recipient = await prisma.recipient.findFirst({ where: { token }, select: { id: true, email: true } });

  if (!recipient) {
    return false;
  }

  try {
    await assertRevalleGatePassed(recipient, requestMetadata);

    return false;
  } catch (error) {
    if (error instanceof AppError && error.code === AppErrorCode.UNAUTHORIZED) {
      return true;
    }

    throw error;
  }
};
