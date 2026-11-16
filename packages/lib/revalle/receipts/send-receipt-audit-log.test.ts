import { setupI18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';

import { type TDocumentAuditLog, ZDocumentAuditLogSchema } from '../../types/document-audit-logs';
import { formatDocumentAuditLogAction } from '../../utils/document-audit-logs';
import { buildSendReceiptData } from './send-receipt';

const i18n = setupI18n({ locale: 'pt-BR', messages: { 'pt-BR': {} } });

const receiptLog = (isResend: boolean) =>
  ({
    id: 'log',
    createdAt: new Date('2026-11-16T12:00:00.000Z'),
    envelopeId: 'envelope_x',
    type: 'REVALLE_SEND_RECEIPT',
    data: buildSendReceiptData({
      receiptId: 'r1',
      recipient: { id: 3, name: 'Fulano', email: 'fulano@exemplo.com', role: 'SIGNER' },
      kind: isResend ? 'RESEND' : 'SEND',
      envelopeTitle: 'Contrato',
      documents: [{ title: 'contrato.pdf', sha256: 'c'.repeat(64) }],
    }),
    name: 'Dono',
    email: 'dono@revalle.com.br',
    userId: 1,
    userAgent: null,
    ipAddress: null,
  }) as unknown as TDocumentAuditLog;

describe('REVALLE_SEND_RECEIPT', () => {
  it('passa no schema do histórico', () => {
    expect(ZDocumentAuditLogSchema.safeParse(receiptLog(false)).success).toBe(true);
  });

  it('texto do histórico', () => {
    expect(formatDocumentAuditLogAction(i18n, receiptLog(false)).description).toBe(
      'Comprovante de envio — Fulano (fulano@exemplo.com)',
    );
    expect(formatDocumentAuditLogAction(i18n, receiptLog(true), 1).description).toBe(
      'Comprovante de envio (reenvio) — Fulano (fulano@exemplo.com)',
    );
  });
});
