// REVALLE: integração com o Patrimônio. Partes puras dos avisos (webhook): eventos, estado do termo, corpo, assinatura
// HMAC e espera entre tentativas.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const PATRIMONIO_TERMO_EVENTS = [
  'termo.sent',
  'termo.signed',
  'termo.rejected',
  'termo.expired',
  'termo.cancelled',
] as const;

export type PatrimonioTermoEvent = (typeof PATRIMONIO_TERMO_EVENTS)[number];

export type PatrimonioTermoStatus = 'PENDING' | 'SIGNED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

/** Evento do Documenso (`WebhookTriggerEvents`) → evento do termo. Os outros eventos não geram aviso. */
const EVENT_BY_WEBHOOK_TRIGGER: Record<string, PatrimonioTermoEvent> = {
  DOCUMENT_SENT: 'termo.sent',
  DOCUMENT_COMPLETED: 'termo.signed',
  DOCUMENT_REJECTED: 'termo.rejected',
  RECIPIENT_EXPIRED: 'termo.expired',
  DOCUMENT_CANCELLED: 'termo.cancelled',
};

export const termoEventForWebhookTrigger = (event: string): PatrimonioTermoEvent | null =>
  EVENT_BY_WEBHOOK_TRIGGER[event] ?? null;

export const TERMO_STATUS_BY_EVENT: Record<PatrimonioTermoEvent, PatrimonioTermoStatus> = {
  'termo.sent': 'PENDING',
  'termo.signed': 'SIGNED',
  'termo.rejected': 'REJECTED',
  'termo.expired': 'EXPIRED',
  'termo.cancelled': 'CANCELLED',
};

/** Todo evento menos `termo.sent` fecha o termo (o `externalId` fica livre para um termo novo). */
export const isFinalTermoEvent = (event: PatrimonioTermoEvent) => event !== 'termo.sent';

type StatusInput = {
  envelopeStatus: string;
  deletedAt: Date | null;
  signer: { signingStatus: string; expiresAt: Date | null } | null;
};

/**
 * Estado exposto ao Patrimônio. `SIGNED` só com o envelope concluído (= selado). Assinado e ainda não selado continua
 * `PENDING`. Recusado conta já na recusa (a selagem da recusa vem logo depois).
 */
export const computeTermoStatus = ({ envelopeStatus, deletedAt, signer }: StatusInput, now = new Date()) => {
  if (deletedAt || envelopeStatus === 'CANCELLED') {
    return 'CANCELLED' satisfies PatrimonioTermoStatus;
  }

  if (envelopeStatus === 'COMPLETED') {
    return 'SIGNED' satisfies PatrimonioTermoStatus;
  }

  if (envelopeStatus === 'REJECTED' || signer?.signingStatus === 'REJECTED') {
    return 'REJECTED' satisfies PatrimonioTermoStatus;
  }

  if (signer && signer.signingStatus === 'NOT_SIGNED' && signer.expiresAt && signer.expiresAt <= now) {
    return 'EXPIRED' satisfies PatrimonioTermoStatus;
  }

  return 'PENDING' satisfies PatrimonioTermoStatus;
};

export type PatrimonioEventBody = {
  eventId: string;
  event: PatrimonioTermoEvent;
  termoId: string;
  externalId: string;
  status: PatrimonioTermoStatus;
  occurredAt: string;
  signer: { name: string; email: string };
  rejectionReason?: string;
};

/** Corpo do aviso com as chaves sempre na mesma ordem (o banco guarda JSONB, que reordena as chaves). */
export const serializeEventBody = (body: PatrimonioEventBody): string =>
  JSON.stringify({
    eventId: body.eventId,
    event: body.event,
    termoId: body.termoId,
    externalId: body.externalId,
    status: body.status,
    occurredAt: body.occurredAt,
    signer: { name: body.signer.name, email: body.signer.email },
    ...(body.rejectionReason ? { rejectionReason: body.rejectionReason } : {}),
  });

/** `sha256=<hex>` do HMAC-SHA256 de `timestamp + "." + corpo bruto`. */
export const signPatrimonioWebhook = (secret: string, timestamp: number | string, rawBody: string): string =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;

/**
 * Conferência do lado de quem recebe (a mesma que a documentação mostra em Python): assinatura em tempo constante e
 * relógio dentro de `toleranceSeconds`.
 */
export const verifyPatrimonioWebhook = ({
  secret,
  timestamp,
  signature,
  rawBody,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
}: {
  secret: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  rawBody: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean => {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) {
    return false;
  }

  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) {
    return false;
  }

  const expected = Buffer.from(signPatrimonioWebhook(secret, timestamp, rawBody));
  const received = Buffer.from(signature);

  return expected.length === received.length && timingSafeEqual(expected, received);
};

export const PATRIMONIO_WEBHOOK_MAX_ATTEMPTS = 5;

/** Espera antes da tentativa seguinte, depois de `attempts` tentativas feitas: 30 s, 2 min, 10 min, 1 h. */
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000];

export const nextAttemptDelayMs = (attempts: number): number | null => {
  if (attempts < 1 || attempts >= PATRIMONIO_WEBHOOK_MAX_ATTEMPTS) {
    return null;
  }

  return RETRY_DELAYS_MS[attempts - 1] ?? null;
};
