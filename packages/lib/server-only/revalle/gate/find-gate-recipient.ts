import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';

export const findRevalleGateRecipient = async (token: string) => {
  const recipient = await prisma.recipient.findFirst({
    where: { token, envelope: { type: EnvelopeType.DOCUMENT, status: DocumentStatus.PENDING } },
    select: { id: true, email: true },
  });

  if (!recipient) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Documento não encontrado.', statusCode: 404 });
  }

  return recipient;
};
