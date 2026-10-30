import { setupI18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';

import type { TDocumentAuditLog } from '../../types/document-audit-logs';
import { formatDocumentAuditLogAction } from '../../utils/document-audit-logs';

const i18n = setupI18n({ locale: 'pt-BR', messages: { 'pt-BR': {} } });

const auditLog = (data: Record<string, unknown>) =>
  ({
    id: 'log',
    createdAt: new Date('2026-10-30T12:00:00.000Z'),
    envelopeId: 'envelope_old',
    type: 'REVALLE_FINANCE_ACCOUNT_CHANGED',
    data: {
      fromCode: '2.1.03',
      fromName: 'Fornecedores',
      toCode: '3.1.01',
      toName: 'Serviços de terceiros',
      reason: 'Conta de serviço, não de material.',
      otherEnvelopeId: 'envelope_new',
      ...data,
    },
    name: 'Financeiro',
    email: 'financeiro@revalle.com.br',
    userId: 7,
    userAgent: null,
    ipAddress: null,
  }) as unknown as TDocumentAuditLog;

describe('REVALLE_FINANCE_ACCOUNT_CHANGED audit text', () => {
  it('describes the superseded version', () => {
    expect(formatDocumentAuditLogAction(i18n, auditLog({ isNewVersion: false })).description).toBe(
      'Conta contábil trocada pelo Financeiro de 2.1.03 – Fornecedores para 3.1.01 – Serviços de terceiros: substituído por uma nova versão. Motivo: Conta de serviço, não de material.',
    );
  });

  it('describes the new version, and an old NF left for Finance', () => {
    expect(
      formatDocumentAuditLogAction(i18n, auditLog({ isNewVersion: true, fromCode: null, fromName: null })).description,
    ).toBe(
      'Nova versão criada pelo Financeiro com a conta contábil 3.1.01 – Serviços de terceiros (antes a definir pelo Financeiro). Motivo: Conta de serviço, não de material.',
    );
  });
});
