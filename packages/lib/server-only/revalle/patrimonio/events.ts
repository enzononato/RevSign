// REVALLE: integração com o Patrimônio. Gancho único em `triggerWebhook`: quando o envelope é um termo do Patrimônio e o
// evento muda o estado dele, grava o aviso (`RevallePatrimonioEvent`) e agenda a entrega. Nunca lança nem segura quem
// chamou: tudo roda em segundo plano e um erro só vai para o log (só códigos e ids).

import { randomUUID } from 'node:crypto';

import { prisma } from '@documenso/prisma';
import { Prisma, RecipientRole, SigningStatus } from '@prisma/client';

import { jobs } from '../../../jobs/client';
import { logger } from '../../../utils/logger';
import { revalleErrorCode } from '../error-code';
import { getPatrimonioWebhookConfig, isPatrimonioEnabled } from './config';
import {
  isFinalTermoEvent,
  type PatrimonioEventBody,
  type PatrimonioTermoEvent,
  TERMO_STATUS_BY_EVENT,
  termoEventForWebhookTrigger,
} from './webhook';

export const PATRIMONIO_WEBHOOK_JOB_ID = 'internal.revalle-patrimonio-webhook';

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const recordEvent = async (event: PatrimonioTermoEvent, envelopeId: string) => {
  const termo = await prisma.revallePatrimonioTermo.findUnique({
    where: { envelopeId },
    select: {
      envelopeId: true,
      externalId: true,
      envelope: {
        select: {
          recipients: {
            where: { role: RecipientRole.SIGNER },
            orderBy: { id: 'asc' },
            select: { name: true, email: true, signingStatus: true, rejectionReason: true },
          },
        },
      },
    },
  });

  if (!termo) {
    return;
  }

  // O termo saiu de pendente: o `externalId` fica livre para um termo novo.
  if (isFinalTermoEvent(event)) {
    await prisma.revallePatrimonioTermo.updateMany({
      where: { envelopeId, activeExternalId: { not: null } },
      data: { activeExternalId: null },
    });
  }

  if (!getPatrimonioWebhookConfig()) {
    return;
  }

  const [signer] = termo.envelope.recipients;
  const rejectionReason =
    event === 'termo.rejected' && signer?.signingStatus === SigningStatus.REJECTED
      ? signer.rejectionReason?.trim() || undefined
      : undefined;

  const id = `evt_${randomUUID().replace(/-/g, '')}`;
  const payload: PatrimonioEventBody = {
    eventId: id,
    event,
    termoId: envelopeId,
    externalId: termo.externalId,
    status: TERMO_STATUS_BY_EVENT[event],
    occurredAt: new Date().toISOString(),
    signer: { name: signer?.name ?? '', email: signer?.email ?? '' },
    ...(rejectionReason ? { rejectionReason } : {}),
  };

  try {
    await prisma.revallePatrimonioEvent.create({
      data: { id, envelopeId, event, payload },
    });
  } catch (error) {
    // Cada estado gera um aviso só (o mesmo evento do Documenso pode vir de novo, ex.: reselagem).
    if (isUniqueViolation(error)) {
      return;
    }

    throw error;
  }

  await jobs.triggerJob({ name: PATRIMONIO_WEBHOOK_JOB_ID, payload: { eventId: id } });
};

/**
 * Chamado no topo de `triggerWebhook`. Síncrono e à prova de erro: o trabalho segue em segundo plano.
 */
export const queuePatrimonioTermoEvent = ({ event, data }: { event: string; data: unknown }): void => {
  try {
    const termoEvent = termoEventForWebhookTrigger(event);
    const envelopeId =
      typeof data === 'object' && data !== null ? (data as { envelopeId?: unknown }).envelopeId : undefined;

    if (!termoEvent || typeof envelopeId !== 'string' || !isPatrimonioEnabled()) {
      return;
    }

    void recordEvent(termoEvent, envelopeId).catch((error: unknown) => {
      logger.error({
        msg: '[RevSign] Patrimônio: falha ao registrar aviso',
        envelopeId,
        event: termoEvent,
        code: revalleErrorCode(error),
      });
    });
  } catch {
    // Nunca atrapalha o caminho do Documenso.
  }
};
