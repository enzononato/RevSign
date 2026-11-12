import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  checkPatrimonioWebhookUrl,
  computeTermoStatus,
  isFinalTermoEvent,
  nextAttemptDelayMs,
  PATRIMONIO_WEBHOOK_MAX_ATTEMPTS,
  serializeEventBody,
  signPatrimonioWebhook,
  termoEventForWebhookTrigger,
  verifyPatrimonioWebhook,
} from './webhook';

const BODY = {
  eventId: 'evt_1',
  event: 'termo.signed' as const,
  termoId: 'envelope_abc',
  externalId: 'PAT-1',
  status: 'SIGNED' as const,
  occurredAt: '2026-11-12T10:00:00.000Z',
  signer: { name: 'Fulano', email: 'fulano@gmail.com' },
};

describe('assinatura HMAC', () => {
  it('é sha256=<hex> de HMAC-SHA256(segredo, timestamp + "." + corpo)', () => {
    const expected = createHmac('sha256', 'segredo').update('1700000000.{"a":1}').digest('hex');

    expect(signPatrimonioWebhook('segredo', 1700000000, '{"a":1}')).toBe(`sha256=${expected}`);
  });

  it('confere a assinatura e o relógio do lado de quem recebe', () => {
    const rawBody = serializeEventBody(BODY);
    const signature = signPatrimonioWebhook('segredo', '1700000000', rawBody);
    const base = { secret: 'segredo', timestamp: '1700000000', signature, rawBody, nowSeconds: 1700000010 };

    expect(verifyPatrimonioWebhook(base)).toBe(true);
    expect(verifyPatrimonioWebhook({ ...base, secret: 'outro' })).toBe(false);
    expect(verifyPatrimonioWebhook({ ...base, rawBody: `${rawBody} ` })).toBe(false);
    expect(verifyPatrimonioWebhook({ ...base, timestamp: '1700000001' })).toBe(false);
    expect(verifyPatrimonioWebhook({ ...base, nowSeconds: 1700000000 + 301 })).toBe(false);
    expect(verifyPatrimonioWebhook({ ...base, signature: null })).toBe(false);
    expect(verifyPatrimonioWebhook({ ...base, timestamp: 'abc' })).toBe(false);
  });
});

describe('corpo do aviso', () => {
  it('sai sempre com as chaves na mesma ordem e sem CPF', () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const shuffled = Object.fromEntries(Object.entries(BODY).reverse()) as typeof BODY;

    expect(serializeEventBody(shuffled)).toBe(serializeEventBody(BODY));
    expect(Object.keys(JSON.parse(serializeEventBody(BODY)))).toEqual([
      'eventId',
      'event',
      'termoId',
      'externalId',
      'status',
      'occurredAt',
      'signer',
    ]);
  });

  it('leva rejectionReason só quando há', () => {
    const rejected = { ...BODY, event: 'termo.rejected' as const, status: 'REJECTED' as const };

    expect(JSON.parse(serializeEventBody({ ...rejected, rejectionReason: 'não recebi' })).rejectionReason).toBe(
      'não recebi',
    );
    expect('rejectionReason' in JSON.parse(serializeEventBody(rejected))).toBe(false);
  });
});

describe('eventos', () => {
  it('mapeia os eventos do Documenso', () => {
    expect(termoEventForWebhookTrigger('DOCUMENT_SENT')).toBe('termo.sent');
    expect(termoEventForWebhookTrigger('DOCUMENT_COMPLETED')).toBe('termo.signed');
    expect(termoEventForWebhookTrigger('DOCUMENT_REJECTED')).toBe('termo.rejected');
    expect(termoEventForWebhookTrigger('RECIPIENT_EXPIRED')).toBe('termo.expired');
    expect(termoEventForWebhookTrigger('DOCUMENT_CANCELLED')).toBe('termo.cancelled');
    expect(termoEventForWebhookTrigger('DOCUMENT_SIGNED')).toBeNull();
    expect(termoEventForWebhookTrigger('DOCUMENT_OPENED')).toBeNull();
    expect(termoEventForWebhookTrigger('DOCUMENT_CREATED')).toBeNull();
  });

  it('só termo.sent mantém o termo aberto', () => {
    expect(isFinalTermoEvent('termo.sent')).toBe(false);
    expect(isFinalTermoEvent('termo.signed')).toBe(true);
    expect(isFinalTermoEvent('termo.expired')).toBe(true);
  });
});

describe('computeTermoStatus', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  const pending = { signingStatus: 'NOT_SIGNED', expiresAt: null };

  it.each([
    ['DRAFT', null, pending, 'PENDING'],
    ['PENDING', null, pending, 'PENDING'],
    ['PENDING', null, { signingStatus: 'SIGNED', expiresAt: null }, 'PENDING'],
    ['COMPLETED', null, { signingStatus: 'SIGNED', expiresAt: null }, 'SIGNED'],
    ['REJECTED', null, { signingStatus: 'REJECTED', expiresAt: null }, 'REJECTED'],
    ['PENDING', null, { signingStatus: 'REJECTED', expiresAt: null }, 'REJECTED'],
    ['CANCELLED', null, pending, 'CANCELLED'],
    ['PENDING', new Date('2026-11-12T11:00:00Z'), pending, 'CANCELLED'],
    ['PENDING', null, { signingStatus: 'NOT_SIGNED', expiresAt: new Date('2026-11-12T11:59:59Z') }, 'EXPIRED'],
    ['PENDING', null, { signingStatus: 'NOT_SIGNED', expiresAt: new Date('2026-11-12T12:00:01Z') }, 'PENDING'],
    ['COMPLETED', null, { signingStatus: 'SIGNED', expiresAt: new Date('2026-11-12T11:00:00Z') }, 'SIGNED'],
    // Excluído depois de concluído ou recusado continua concluído ou recusado (a exclusão só esconde da lista).
    ['COMPLETED', new Date('2026-11-12T11:00:00Z'), { signingStatus: 'SIGNED', expiresAt: null }, 'SIGNED'],
    ['REJECTED', new Date('2026-11-12T11:00:00Z'), { signingStatus: 'REJECTED', expiresAt: null }, 'REJECTED'],
  ] as const)('%s, apagado=%s → %s', (envelopeStatus, deletedAt, signer, expected) => {
    expect(computeTermoStatus({ envelopeStatus, deletedAt, signer }, now)).toBe(expected);
  });
});

describe('tentativas', () => {
  it('espera 30 s, 2 min, 10 min e 1 h; para depois da 5ª', () => {
    expect(PATRIMONIO_WEBHOOK_MAX_ATTEMPTS).toBe(5);
    expect([1, 2, 3, 4].map(nextAttemptDelayMs)).toEqual([30_000, 120_000, 600_000, 3_600_000]);
    expect(nextAttemptDelayMs(5)).toBeNull();
    expect(nextAttemptDelayMs(0)).toBeNull();
  });
});

describe('checkPatrimonioWebhookUrl', () => {
  it.each([
    'https://patrimonio.revalle.com.br/revsign/webhook',
    'https://203.0.113.10/hook',
    'http://revalle_patrimonio-api:8000/revsign/webhook',
    'http://patrimonio-hook:8799/hook',
    'http://localhost:8080/hook',
    'http://10.0.1.5/hook',
    'http://172.20.0.3:8000/hook',
    'http://192.168.0.10/hook',
    'http://127.0.0.1:9000/hook',
    'http://[fd12:3456::1]/hook',
    'http://[::1]:8000/hook',
  ])('aceita %s', (url) => {
    expect(checkPatrimonioWebhookUrl(url)).toBeNull();
  });

  it.each([
    'http://patrimonio.revalle.com.br/hook',
    'http://host.docker.internal:8799/hook',
    'http://203.0.113.10/hook',
    'http://172.32.0.1/hook',
    'http://[2001:db8::1]/hook',
  ])('recusa http fora da rede interna: %s', (url) => {
    expect(checkPatrimonioWebhookUrl(url)).toBe('WEBHOOK_URL_NOT_HTTPS');
  });

  it.each([
    'ftp://patrimonio-api/hook',
    'não é url',
    'https://user:senha@patrimonio.revalle.com.br/hook',
    'file:///etc/x',
  ])('recusa endereço inválido: %s', (url) => {
    expect(checkPatrimonioWebhookUrl(url)).toBe('WEBHOOK_URL_INVALID');
  });
});
