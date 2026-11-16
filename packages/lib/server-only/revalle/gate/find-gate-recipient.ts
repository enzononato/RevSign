import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, RecipientRole, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { assertRevalleRecipientAccount, type RevalleSigningActor } from '../account-required/account-required';
import { isSupersededPendingVersion, supersededVersionError } from './superseded-version';

/** Etapas do portão (termo, CPF, confirmação): também só com a conta do e-mail da empresa, quando ela é exigida. */
export const findRevalleGateRecipient = async (token: string, actor: RevalleSigningActor) => {
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

  await assertRevalleRecipientAccount(recipient, actor);

  return recipient;
};
