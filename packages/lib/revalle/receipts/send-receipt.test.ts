import { describe, expect, it } from 'vitest';

import {
  buildSendReceiptData,
  buildSendReceiptLines,
  formatReceiptDateTime,
  formatSendReceiptHistoryLine,
  sendReceiptPath,
} from './send-receipt';

const documents = [
  { title: 'contrato.pdf', sha256: 'a'.repeat(64) },
  { title: 'anexo.pdf', sha256: 'b'.repeat(64) },
];

const recipient = { id: 7, name: 'Fulano de Tal', email: 'fulano@exemplo.com', role: 'SIGNER' };

describe('buildSendReceiptData', () => {
  it('primeiro envio: canal e-mail, sem reenvio, documentos na ordem', () => {
    const data = buildSendReceiptData({
      receiptId: 'r1',
      recipient,
      kind: 'SEND',
      envelopeTitle: 'Contrato',
      documents,
    });

    expect(data).toEqual({
      receiptId: 'r1',
      recipientId: 7,
      recipientName: 'Fulano de Tal',
      recipientEmail: 'fulano@exemplo.com',
      recipientRole: 'SIGNER',
      channel: 'EMAIL',
      isResend: false,
      kind: 'SEND',
      envelopeTitle: 'Contrato',
      documents,
    });
  });

  it('reenvio e lembrete marcam isResend', () => {
    for (const kind of ['RESEND', 'REMINDER'] as const) {
      expect(buildSendReceiptData({ receiptId: 'r', recipient, kind, envelopeTitle: 'X', documents }).isResend).toBe(
        true,
      );
    }
  });

  it('não leva nada além de nome, e-mail e papel do destinatário', () => {
    const data = buildSendReceiptData({
      receiptId: 'r',
      recipient: { ...recipient, token: 'segredo', cpf: '12345678909' } as typeof recipient,
      kind: 'SEND',
      envelopeTitle: 'X',
      documents,
    });

    expect(JSON.stringify(data)).not.toContain('segredo');
    expect(JSON.stringify(data)).not.toContain('12345678909');
  });
});

describe('formatação', () => {
  it('data e hora em Brasília, com segundos', () => {
    expect(formatReceiptDateTime(new Date('2026-11-16T15:04:05Z'))).toBe('16/11/2026 12:04:05');
  });

  it('linha do histórico', () => {
    expect(
      formatSendReceiptHistoryLine(
        { recipientName: 'Fulano', recipientEmail: 'f@x.com', isResend: true },
        new Date('2026-11-16T15:04:05Z'),
      ),
    ).toBe('Comprovante de envio (reenvio) — Fulano (f@x.com) — 16/11/2026 12:04');
  });

  it('caminho do PDF', () => {
    expect(sendReceiptPath({ teamUrl: 'time', envelopeId: 'envelope_x', receiptId: 'abc' })).toBe(
      '/t/time/documents/envelope_x/comprovantes/abc',
    );
  });
});

describe('buildSendReceiptLines', () => {
  const data = buildSendReceiptData({
    receiptId: 'r1',
    recipient,
    kind: 'RESEND',
    envelopeTitle: 'Contrato',
    documents,
  });
  const createdAt = new Date('2026-11-16T15:04:05Z');

  const text = (lines: ReturnType<typeof buildSendReceiptLines>) =>
    lines.map((line) => ('text' in line ? line.text : 'label' in line ? `${line.label} ${line.value}` : '')).join('\n');

  it('tem título, envelope, documentos com SHA-256, destinatário, canal, horário de Brasília, reenvio e id', () => {
    const content = text(buildSendReceiptLines({ data, createdAt, fallbackEnvelopeTitle: 'Outro' }));

    for (const expected of [
      'RevSign',
      'Comprovante de envio',
      'Título Contrato',
      '1. contrato.pdf',
      `SHA-256 ${'a'.repeat(64)}`,
      '2. anexo.pdf',
      `SHA-256 ${'b'.repeat(64)}`,
      'Nome Fulano de Tal',
      'E-mail fulano@exemplo.com',
      'Papel Signatário (assinar)',
      'Canal E-mail',
      'Tipo Reenvio',
      'Data e hora 16/11/2026 12:04:05 (horário de Brasília)',
      'Comprovante nº r1',
    ]) {
      expect(content).toContain(expected);
    }

    expect(content).not.toContain('Outro');
  });

  it('determinístico: o mesmo evento gera as mesmas linhas', () => {
    expect(buildSendReceiptLines({ data, createdAt, fallbackEnvelopeTitle: 'A' })).toEqual(
      buildSendReceiptLines({ data, createdAt, fallbackEnvelopeTitle: 'A' }),
    );
  });

  it('evento sem o título gravado usa o título atual', () => {
    const { envelopeTitle: _omit, ...legacy } = data;
    const content = text(buildSendReceiptLines({ data: legacy, createdAt, fallbackEnvelopeTitle: 'Atual' }));

    expect(content).toContain('Título Atual');
  });
});
