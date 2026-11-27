import { describe, expect, it } from 'vitest';

import {
  buildRecipientTimeline,
  collectRecipientSendEvents,
  recipientStage,
  recipientStageLabel,
  serializeTimeline,
} from './recipient-stage';

const at = (iso: string) => new Date(iso);

describe('recipientStage / recipientStageLabel', () => {
  it('segue a ordem Recusou > Assinou > Visualizado > Enviado > não enviado', () => {
    const base = { role: 'SIGNER', sendStatus: 'SENT', readStatus: 'NOT_OPENED', signingStatus: 'NOT_SIGNED' };

    expect(recipientStage({ ...base, sendStatus: 'NOT_SENT' })).toBe('NOT_SENT');
    expect(recipientStageLabel(base)).toBe('Enviado');
    expect(recipientStageLabel({ ...base, readStatus: 'OPENED' })).toBe('Visualizado');
    expect(recipientStageLabel({ ...base, readStatus: 'OPENED', signingStatus: 'SIGNED' })).toBe('Assinou');
    expect(recipientStageLabel({ ...base, signingStatus: 'REJECTED' })).toBe('Recusou');
    expect(recipientStageLabel({ ...base, sendStatus: 'NOT_SENT' })).toBe('Ainda não enviado');
  });

  it('usa o verbo do papel quando concluiu', () => {
    expect(recipientStageLabel({ role: 'APPROVER', signingStatus: 'SIGNED' })).toBe('Aprovou');
  });
});

describe('collectRecipientSendEvents', () => {
  it('pega o último comprovante, a primeira abertura e a recusa por destinatário', () => {
    const events = collectRecipientSendEvents([
      { type: 'REVALLE_SEND_RECEIPT', createdAt: at('2026-11-16T12:00:00Z'), data: { recipientId: 1, receiptId: 'a' } },
      { type: 'REVALLE_SEND_RECEIPT', createdAt: at('2026-11-16T15:00:00Z'), data: { recipientId: 1, receiptId: 'b' } },
      { type: 'DOCUMENT_OPENED', createdAt: at('2026-11-16T16:00:00Z'), data: { recipientId: 1 } },
      { type: 'DOCUMENT_OPENED', createdAt: at('2026-11-16T13:00:00Z'), data: { recipientId: 1 } },
      { type: 'DOCUMENT_RECIPIENT_REJECTED', createdAt: at('2026-11-16T17:00:00Z'), data: { recipientId: 2 } },
      { type: 'DOCUMENT_VIEWED', createdAt: at('2026-11-16T11:00:00Z'), data: { recipientId: 3 } },
      { type: 'EMAIL_SENT', createdAt: at('2026-11-16T11:00:00Z'), data: { recipientId: 4, emailType: 'CC' } },
    ]);

    expect(events.get(1)).toEqual({
      sentAt: at('2026-11-16T15:00:00Z'),
      latestReceiptId: 'b',
      openedAt: at('2026-11-16T13:00:00Z'),
      rejectedAt: null,
    });
    expect(events.get(2)?.rejectedAt).toEqual(at('2026-11-16T17:00:00Z'));
    // Ver o documento também é abrir o link.
    expect(events.get(3)?.openedAt).toEqual(at('2026-11-16T11:00:00Z'));
    // Cópia final não é convite.
    expect(events.has(4)).toBe(false);
  });

  it('os passos do portão (só com o e-mail) contam como abertura do link; e-mail repetido no envelope não liga', () => {
    const events = collectRecipientSendEvents(
      [
        { type: 'REVALLE_TERM_ACCEPTED', createdAt: at('2026-11-16T12:30:00Z'), data: {}, email: 'Ana@Exemplo.com' },
        { type: 'REVALLE_TERM_ACCEPTED', createdAt: at('2026-11-16T12:40:00Z'), data: {}, email: 'dup@exemplo.com' },
        { type: 'REVALLE_GATE_UNLOCKED', createdAt: at('2026-11-16T12:10:00Z'), data: {}, email: 'ana@exemplo.com' },
        { type: 'DOCUMENT_OPENED', createdAt: at('2026-11-16T13:00:00Z'), data: { recipientId: 1 } },
      ],
      [
        { id: 1, email: 'ana@exemplo.com' },
        { id: 2, email: 'dup@exemplo.com' },
        { id: 3, email: 'DUP@exemplo.com' },
      ],
    );

    expect(events.get(1)?.openedAt).toEqual(at('2026-11-16T12:30:00Z'));
    expect(events.has(2)).toBe(false);
    expect(events.has(3)).toBe(false);
  });

  it('documento de antes do comprovante: o último convite por e-mail vale como Enviado; o comprovante ganha', () => {
    const events = collectRecipientSendEvents([
      {
        type: 'EMAIL_SENT',
        createdAt: at('2026-11-10T12:00:00Z'),
        data: { recipientId: 1, emailType: 'SIGNING_REQUEST' },
      },
      {
        type: 'EMAIL_SENT',
        createdAt: at('2026-11-11T12:00:00Z'),
        data: { recipientId: 1, emailType: 'DOCUMENT_COMPLETED' },
      },
      { type: 'EMAIL_SENT', createdAt: at('2026-11-10T12:00:00Z'), data: { recipientId: 2, emailType: 'REMINDER' } },
      { type: 'REVALLE_SEND_RECEIPT', createdAt: at('2026-11-09T12:00:00Z'), data: { recipientId: 2, receiptId: 'r' } },
    ]);

    expect(events.get(1)?.sentAt).toEqual(at('2026-11-10T12:00:00Z'));
    expect(events.get(1)?.latestReceiptId).toBeNull();
    expect(events.get(2)?.sentAt).toEqual(at('2026-11-09T12:00:00Z'));
    expect(events.get(2)?.latestReceiptId).toBe('r');
  });
});

describe('buildRecipientTimeline', () => {
  const sentAt = at('2026-11-16T12:00:00Z');
  const openedAt = at('2026-11-16T13:00:00Z');

  it('antes de abrir: só Enviado', () => {
    const steps = buildRecipientTimeline(
      { role: 'SIGNER', readStatus: 'NOT_OPENED', signingStatus: 'NOT_SIGNED', signedAt: null },
      { sentAt, latestReceiptId: 'a', openedAt: null, rejectedAt: null },
    );

    expect(steps.map((step) => [step.key, step.reached])).toEqual([
      ['SENT', true],
      ['VIEWED', false],
      ['SIGNED', false],
    ]);
  });

  it('assinado: os 3 passos com horário', () => {
    const signedAt = at('2026-11-16T14:30:00Z');
    const steps = buildRecipientTimeline(
      { role: 'SIGNER', readStatus: 'OPENED', signingStatus: 'SIGNED', signedAt },
      { sentAt, latestReceiptId: 'a', openedAt, rejectedAt: null },
    );

    expect(serializeTimeline(steps)).toEqual([
      { key: 'SENT', label: 'Enviado', reached: true, atLabel: '16/11/2026 09:00' },
      { key: 'VIEWED', label: 'Visualizado', reached: true, atLabel: '16/11/2026 10:00' },
      { key: 'SIGNED', label: 'Assinado', reached: true, atLabel: '16/11/2026 11:30' },
    ]);
  });

  it('recusado: último passo Recusado com o horário da recusa', () => {
    const steps = buildRecipientTimeline(
      { role: 'SIGNER', readStatus: 'OPENED', signingStatus: 'REJECTED', signedAt: at('2026-11-16T18:00:00Z') },
      { sentAt, latestReceiptId: 'a', openedAt, rejectedAt: at('2026-11-16T17:00:00Z') },
    );

    expect(steps[2]).toEqual({ key: 'REJECTED', label: 'Recusado', reached: true, at: at('2026-11-16T17:00:00Z') });
  });

  it('abriu antes do histórico guardar a abertura: Visualizado sem horário; sem envio por e-mail: Enviado cinza', () => {
    const steps = buildRecipientTimeline(
      { role: 'APPROVER', readStatus: 'OPENED', signingStatus: 'NOT_SIGNED' },
      undefined,
    );

    expect(steps.map((step) => [step.key, step.label, step.reached, step.at])).toEqual([
      ['SENT', 'Enviado', false, null],
      ['VIEWED', 'Visualizado', true, null],
      ['SIGNED', 'Aprovado', false, null],
    ]);
  });

  it('cópia (CC) não tem passos', () => {
    expect(buildRecipientTimeline({ role: 'CC', signingStatus: 'SIGNED' }, undefined)).toEqual([]);
  });
});

describe('autenticador no passo Assinado (v.26)', () => {
  const sentAt = at('2026-11-16T12:00:00Z');
  const signedAt = at('2026-11-16T14:30:00Z');
  const signer = { role: 'SIGNER', readStatus: 'OPENED', signingStatus: 'SIGNED', signedAt };

  it('a última confirmação pelo autenticador põe o texto no passo Assinado; pelo e-mail, não', () => {
    const events = collectRecipientSendEvents([
      { type: 'REVALLE_SEND_RECEIPT', createdAt: sentAt, data: { recipientId: 1, receiptId: 'a' } },
      { type: 'REVALLE_SEND_RECEIPT', createdAt: sentAt, data: { recipientId: 2, receiptId: 'b' } },
      {
        type: 'DOCUMENT_ACCESS_AUTH_2FA_VALIDATED',
        createdAt: at('2026-11-16T14:29:00Z'),
        data: { recipientId: 1, revalleMethod: 'AUTHENTICATOR' },
      },
      {
        type: 'DOCUMENT_ACCESS_AUTH_2FA_VALIDATED',
        createdAt: at('2026-11-16T14:00:00Z'),
        data: { recipientId: 2, revalleMethod: 'AUTHENTICATOR' },
      },
      { type: 'DOCUMENT_ACCESS_AUTH_2FA_VALIDATED', createdAt: at('2026-11-16T14:29:00Z'), data: { recipientId: 2 } },
    ]);

    const byAuthenticator = buildRecipientTimeline(signer, events.get(1));
    const byEmail = buildRecipientTimeline(signer, events.get(2));

    expect(byAuthenticator[2]).toMatchObject({ key: 'SIGNED', detail: 'Assinatura confirmada pelo app autenticador' });
    expect(serializeTimeline(byAuthenticator)[2].detail).toBe('Assinatura confirmada pelo app autenticador');
    expect(byEmail[2].detail).toBeUndefined();
  });

  it('ainda não assinou: sem o texto, mesmo com o código validado', () => {
    const events = collectRecipientSendEvents([
      {
        type: 'DOCUMENT_ACCESS_AUTH_2FA_VALIDATED',
        createdAt: sentAt,
        data: { recipientId: 1, revalleMethod: 'AUTHENTICATOR' },
      },
    ]);
    const steps = buildRecipientTimeline({ ...signer, signingStatus: 'NOT_SIGNED', signedAt: null }, events.get(1));

    expect(steps[2].detail).toBeUndefined();
  });
});
