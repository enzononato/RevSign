// REVALLE: integração com o Patrimônio. Entrega de um aviso: POST com HMAC, até 5 tentativas espaçadas (30 s, 2 min,
// 10 min, 1 h). A espera curta roda no próprio processo; a varredura de 15 em 15 minutos pega o que ficou para trás
// (reinício do app no meio da espera). Resposta 2xx = entregue. Nunca lança por falha de entrega: o job não repete
// sozinho (as repetições do provedor de jobs seriam imediatas).

import { prisma } from '@documenso/prisma';

import { jobs } from '../../../jobs/client';
import { fetchWithTimeout } from '../../../utils/timeout';
import { revalleErrorCode } from '../error-code';
import { getPatrimonioWebhookConfig } from './config';
import { PATRIMONIO_WEBHOOK_JOB_ID } from './events';
import {
  checkPatrimonioWebhookUrl,
  nextAttemptDelayMs,
  PATRIMONIO_WEBHOOK_MAX_ATTEMPTS,
  type PatrimonioEventBody,
  serializeEventBody,
  signPatrimonioWebhook,
} from './webhook';

const DELIVERY_TIMEOUT_MS = 10_000;

/** Endereço do aviso fora da regra: a varredura tenta de novo (a cada 15 min) até a variável ser corrigida. */
const URL_ERROR_RETRY_MS = 15 * 60_000;

/** Enquanto uma tentativa roda, ninguém mais pega o aviso (a varredura só pega `nextAttemptAt` vencido). */
const ATTEMPT_LEASE_MS = 2 * 60_000;

/** Folga para o relógio: o temporizador pode disparar um pouco antes de `nextAttemptAt`. */
const CLOCK_SLACK_MS = 15_000;

const scheduleRetry = (eventId: string, delayMs: number) => {
  const timer = setTimeout(() => {
    void jobs.triggerJob({ name: PATRIMONIO_WEBHOOK_JOB_ID, payload: { eventId } }).catch(() => undefined);
  }, delayMs);

  timer.unref?.();
};

export const deliverPatrimonioEvent = async (eventId: string): Promise<'DELIVERED' | 'FAILED' | 'SKIPPED'> => {
  const config = getPatrimonioWebhookConfig();

  if (!config) {
    return 'SKIPPED';
  }

  // Endereço fora da regra (http:// para fora da rede interna, ou inválido): nem tenta. A tentativa não conta; a
  // varredura tenta de novo depois que a variável for corrigida.
  const urlError = checkPatrimonioWebhookUrl(config.url);

  if (urlError) {
    await prisma.revallePatrimonioEvent.updateMany({
      where: { id: eventId, deliveredAt: null },
      data: { lastError: urlError, nextAttemptAt: new Date(Date.now() + URL_ERROR_RETRY_MS) },
    });

    console.error(`[RevSign] Patrimônio: aviso ${eventId} não enviado (${urlError})`);

    return 'SKIPPED';
  }

  const now = new Date();

  // Pega a tentativa de forma atômica: dois disparos ao mesmo tempo não entregam duas vezes.
  const claimed = await prisma.revallePatrimonioEvent.updateMany({
    where: {
      id: eventId,
      deliveredAt: null,
      attempts: { lt: PATRIMONIO_WEBHOOK_MAX_ATTEMPTS },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date(now.getTime() + CLOCK_SLACK_MS) } }],
    },
    data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + ATTEMPT_LEASE_MS) },
  });

  if (claimed.count === 0) {
    return 'SKIPPED';
  }

  const row = await prisma.revallePatrimonioEvent.findUniqueOrThrow({ where: { id: eventId } });
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const body = serializeEventBody(row.payload as unknown as PatrimonioEventBody);
  const timestamp = Math.floor(Date.now() / 1000);

  let error: string | null = null;

  try {
    // Só o endereço configurado pelo operador recebe o aviso, mesmo sendo interno (IP privado): a proteção contra SSRF
    // dos webhooks de time (`assertNotPrivateUrl`) não vale aqui e `NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS` não é usada.
    const response = await fetchWithTimeout(config.url, {
      method: 'POST',
      body,
      redirect: 'manual',
      timeoutMs: DELIVERY_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'RevSign-Patrimonio/1',
        'X-RevSign-Event': row.event,
        'X-RevSign-Event-Id': row.id,
        'X-RevSign-Timestamp': String(timestamp),
        'X-RevSign-Signature': signPatrimonioWebhook(config.secret, timestamp, body),
      },
    });

    // O corpo da resposta não interessa (nem vai para o banco).
    await response.body?.cancel().catch(() => undefined);

    if (!response.ok) {
      error = `HTTP_${response.status}`;
    }
  } catch (caught) {
    error = revalleErrorCode(caught).slice(0, 100);
  }

  if (error === null) {
    await prisma.revallePatrimonioEvent.update({
      where: { id: eventId },
      data: { deliveredAt: new Date(), nextAttemptAt: null, lastError: null },
    });

    return 'DELIVERED';
  }

  const delay = nextAttemptDelayMs(row.attempts);

  await prisma.revallePatrimonioEvent.update({
    where: { id: eventId },
    data: { lastError: error, nextAttemptAt: delay === null ? null : new Date(Date.now() + delay) },
  });

  if (delay !== null) {
    scheduleRetry(eventId, delay);
  }

  console.error(`[RevSign] Patrimônio: aviso ${eventId} não entregue (tentativa ${row.attempts}, ${error})`);

  return 'FAILED';
};

/** Varredura: avisos não entregues com a próxima tentativa vencida (ex.: o app reiniciou durante a espera). */
export const sweepPatrimonioEvents = async () => {
  if (!getPatrimonioWebhookConfig()) {
    return 0;
  }

  const due = await prisma.revallePatrimonioEvent.findMany({
    where: {
      deliveredAt: null,
      attempts: { lt: PATRIMONIO_WEBHOOK_MAX_ATTEMPTS },
      OR: [
        { nextAttemptAt: { lte: new Date() } },
        // Criado e nunca tentado (o job da primeira tentativa se perdeu).
        { nextAttemptAt: null, attempts: 0, createdAt: { lte: new Date(Date.now() - 60_000) } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: { id: true },
  });

  for (const { id } of due) {
    await jobs.triggerJob({ name: PATRIMONIO_WEBHOOK_JOB_ID, payload: { eventId: id } });
  }

  return due.length;
};
