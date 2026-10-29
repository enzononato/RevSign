import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, SigningStatus } from '@prisma/client';

import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { getRevalleGateState } from './get-gate-state';
import type { RevalleGateState } from './types';

export type RevalleGateLoaderPayload = {
  revalleGate: Exclude<RevalleGateState, { status: 'PASSED' }>;
  token: string;
  recipientName: string;
  senderName: string | null;
};

/**
 * Consulta leve (sem carregar documento, campos ou arquivos) usada pelos loaders da página de assinatura.
 * Devolve o payload mínimo da tela do portão, ou null quando o portão não se aplica ou já foi passado.
 */
export const getRevalleGateLoaderPayload = async (
  token: string,
  requestMetadata?: RequestMetadata,
): Promise<RevalleGateLoaderPayload | null> => {
  const recipient = await prisma.recipient.findFirst({
    where: {
      token,
      signingStatus: SigningStatus.NOT_SIGNED,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      envelope: { type: EnvelopeType.DOCUMENT, status: DocumentStatus.PENDING, deletedAt: null },
    },
    select: {
      id: true,
      email: true,
      role: true,
      signingStatus: true,
      name: true,
      envelope: { select: { user: { select: { name: true } } } },
    },
  });

  if (!recipient) {
    return null;
  }

  const state = await getRevalleGateState(recipient, requestMetadata);

  if (state.status === 'PASSED') {
    return null;
  }

  return {
    revalleGate: state,
    token,
    recipientName: recipient.name,
    senderName: recipient.envelope.user.name,
  };
};

/**
 * Estado do portão para as subrotas da página de assinatura (concluído, recusado, expirado), em qualquer estado do documento.
 * Devolve true quando há dados do documento que ainda não podem ser mostrados a este destinatário.
 */
export const isRevalleGateBlockingToken = async (
  token: string,
  requestMetadata?: RequestMetadata,
): Promise<boolean> => {
  const recipient = await prisma.recipient.findFirst({
    where: { token },
    select: { id: true, email: true, role: true, signingStatus: true },
  });

  if (!recipient) {
    return false;
  }

  const state = await getRevalleGateState(recipient, requestMetadata);

  return state.status !== 'PASSED';
};
