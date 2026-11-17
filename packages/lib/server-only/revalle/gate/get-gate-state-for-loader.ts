import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, SigningStatus } from '@prisma/client';

import { greetingName } from '../../../revalle/recipient-name';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { getRevalleGateState } from './get-gate-state';
import { isSupersededPendingVersion } from './superseded-version';
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
  // Versão substituída pelo Financeiro: a mensagem vale para qualquer destinatário (inclusive quem já assinou), mesmo
  // com a versão escondida das listas (excluída) e antes de qualquer dado do documento.
  const superseded = await prisma.recipient.findFirst({
    where: { token, envelope: { type: EnvelopeType.DOCUMENT } },
    select: { id: true, name: true, email: true, envelope: { select: { user: { select: { name: true } } } } },
  });

  if (superseded && (await isSupersededPendingVersion({ recipientId: superseded.id }))) {
    return {
      revalleGate: { status: 'SUPERSEDED' },
      token,
      recipientName: greetingName(superseded.name, superseded.email),
      senderName: superseded.envelope.user.name,
    };
  }

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
    // Sem nome ainda (só o e-mail no envio): "Olá, e-mail", nunca "Olá, ".
    recipientName: greetingName(recipient.name, recipient.email),
    senderName: recipient.envelope.user.name,
  };
};

/**
 * Estado do portão para as subrotas da página de assinatura (concluído, recusado, expirado), em qualquer estado do documento.
 * Devolve true quando há dados do documento que ainda não podem ser mostrados a este destinatário.
 */
export const isRevalleGatePendingForToken = async (
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
