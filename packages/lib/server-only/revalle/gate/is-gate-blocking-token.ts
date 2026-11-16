import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { isRevalleAccountErrorCode } from '../../../revalle/account-required/rule';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import type { RevalleSigningActor } from '../account-required/account-required';
import { assertRevalleGatePassed } from './assert-gate-passed';
import { REVALLE_DOCUMENT_SUPERSEDED_CODE } from './superseded-version';

/**
 * Para as rotas de arquivo (Hono) que aceitam o token do destinatário: devolve `true` quando o portão do dono do token
 * ainda não foi concluído ou quando falta a conta do e-mail da empresa (`actor`: a sessão do pedido). Tokens `qr_`
 * (compartilhamento de documento concluído) e token desconhecido não passam por aqui.
 */
export const isRevalleGateBlockingToken = async (
  token: string,
  requestMetadata: RequestMetadata | undefined,
  actor: RevalleSigningActor,
): Promise<boolean> => {
  if (token.startsWith('qr_')) {
    return false;
  }

  const recipient = await prisma.recipient.findFirst({
    where: { token },
    select: { id: true, email: true, role: true, signingStatus: true },
  });

  if (!recipient) {
    return false;
  }

  try {
    await assertRevalleGatePassed(recipient, requestMetadata, actor);

    return false;
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === AppErrorCode.UNAUTHORIZED ||
        error.code === REVALLE_DOCUMENT_SUPERSEDED_CODE ||
        isRevalleAccountErrorCode(error.code))
    ) {
      return true;
    }

    throw error;
  }
};
