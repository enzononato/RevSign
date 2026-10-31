import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, RecipientRole, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { isSupersededPendingVersion, supersededVersionError } from './superseded-version';

export const findRevalleGateRecipient = async (token: string) => {
  const recipient = await prisma.recipient.findFirst({
    where: {
      token,
      role: { notIn: [RecipientRole.CC, RecipientRole.VIEWER] },
      signingStatus: SigningStatus.NOT_SIGNED,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      envelope: { type: EnvelopeType.DOCUMENT, status: DocumentStatus.PENDING },
    },
    select: { id: true, email: true, role: true, signingStatus: true },
  });

  if (!recipient) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Documento não encontrado.', statusCode: 404 });
  }

  if (await isSupersededPendingVersion({ recipientId: recipient.id })) {
    throw supersededVersionError();
  }

  return recipient;
};
