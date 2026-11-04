import { describe, expect, it } from 'vitest';

import {
  buildAccountChangeNotice,
  buildVersionChangeNotice,
  formatInvoiceAccount,
  isValidChangeReason,
  nextClassification,
  nextVersionTitle,
  versionChangeNoticeLine,
} from './account-change';

describe('nextVersionTitle', () => {
  it('adds the version suffix to the base title', () => {
    expect(nextVersionTitle('NF 123.pdf', 2)).toBe('NF 123.pdf (v2)');
  });

  it('replaces an existing suffix instead of stacking it', () => {
    expect(nextVersionTitle('NF 123 (v2)', 3)).toBe('NF 123 (v3)');
    expect(nextVersionTitle('NF 123 (v12)', 13)).toBe('NF 123 (v13)');
  });

  it('keeps a "(vN)" that is not the final suffix', () => {
    expect(nextVersionTitle('Contrato (v2) anexo', 2)).toBe('Contrato (v2) anexo (v2)');
  });
});

describe('buildAccountChangeNotice', () => {
  const base = {
    title: 'NF 123',
    from: '2.1.03 – Fornecedores',
    to: '3.1.01 – Serviços de terceiros',
  };

  it('uses the exact text, with the reason', () => {
    expect(buildAccountChangeNotice({ ...base, reason: 'Conta de serviço, não de material' })).toBe(
      'A conta contábil da nota fiscal NF 123 foi alterada pelo Financeiro de 2.1.03 – Fornecedores para 3.1.01 – Serviços de terceiros. Motivo: Conta de serviço, não de material.',
    );
  });

  it('says the account was defined when the replaced version had none', () => {
    expect(buildAccountChangeNotice({ ...base, from: null, reason: 'Faltava a conta' })).toBe(
      'A conta contábil da nota fiscal NF 123 foi definida pelo Financeiro: 3.1.01 – Serviços de terceiros. Motivo: Faltava a conta.',
    );
  });

  it('does not double the final punctuation of the reason', () => {
    expect(buildAccountChangeNotice({ ...base, reason: 'Conta de serviço, não de material.' })).toMatch(
      /Motivo: Conta de serviço, não de material\.$/,
    );
    expect(buildAccountChangeNotice({ ...base, reason: 'Era serviço!' })).toMatch(/Motivo: Era serviço!$/);
  });
});

describe('versionChangeNoticeLine', () => {
  it('uses the exact sentence for a corrected cost center', () => {
    expect(versionChangeNoticeLine({ kind: 'COST_CENTER', fromCode: '101', toCode: '201' })).toBe(
      'O centro de custo foi corrigido de 101 – Puxada para 201 – Armazém.',
    );
  });

  it('adds the reason without doubling the final punctuation', () => {
    const change = { kind: 'COST_CENTER', fromCode: '101', toCode: '201' } as const;

    expect(buildVersionChangeNotice(change, 'Era do armazém')).toBe(
      'O centro de custo foi corrigido de 101 – Puxada para 201 – Armazém. Motivo: Era do armazém.',
    );
    expect(buildVersionChangeNotice(change, 'Era do armazém!')).toMatch(/Motivo: Era do armazém!$/);
  });
});

describe('nextClassification', () => {
  const previousDay = new Date('2026-11-03T12:00:00.000Z');
  const now = new Date('2026-11-04T12:00:00.000Z');
  const user = { id: 9, name: '  Quem Mudou  ' };
  const row = {
    choiceCode: '2.1.03',
    choiceById: 1,
    choiceAt: previousDay,
    costCenterCode: '101',
    costCenterById: 1,
    costCenterAt: previousDay,
    costCenterValidatedAt: previousDay,
    costCenterValidatedById: 2,
    costCenterValidatedByName: 'Contabilidade',
    financeStatus: 'PENDING_APPROVAL' as const,
    approvedById: null,
    approvedAt: null,
    approvedAccountName: null,
    approvedByName: null,
  };
  const approved = {
    ...row,
    financeStatus: 'APPROVED' as const,
    approvedById: 3,
    approvedAt: previousDay,
    approvedAccountName: 'Fornecedores',
    approvedByName: 'Financeiro',
  };

  it('a troca de conta aprova por quem trocou e mantém o centro e a validação', () => {
    expect(nextClassification(row, { kind: 'ACCOUNT', code: '3.1.01' }, user, now, 'Serviços')).toEqual({
      ...row,
      choiceCode: '3.1.01',
      choiceById: 9,
      choiceAt: now,
      financeStatus: 'APPROVED',
      approvedById: 9,
      approvedAt: now,
      approvedAccountName: 'Serviços',
      approvedByName: 'Quem Mudou',
    });
  });

  it('a correção do centro mantém a conta e a situação, e valida por quem corrigiu', () => {
    expect(nextClassification(approved, { kind: 'COST_CENTER', code: '201' }, user, now, null)).toEqual({
      ...approved,
      costCenterCode: '201',
      costCenterById: 9,
      costCenterAt: now,
      costCenterValidatedAt: now,
      costCenterValidatedById: 9,
      costCenterValidatedByName: 'Quem Mudou',
    });
    expect(nextClassification(row, { kind: 'COST_CENTER', code: '201' }, user, now, null).financeStatus).toBe(
      'PENDING_APPROVAL',
    );
  });

  it('a retomada lê a situação pela aprovação; LEGACY aguarda o Financeiro', () => {
    const correct = { kind: 'COST_CENTER', code: '201' } as const;

    expect(nextClassification({ ...row, financeStatus: 'SUPERSEDED' }, correct, user, now, null).financeStatus).toBe(
      'PENDING_APPROVAL',
    );
    expect(
      nextClassification({ ...approved, financeStatus: 'SUPERSEDED' }, correct, user, now, null).financeStatus,
    ).toBe('APPROVED');
    expect(nextClassification({ ...row, financeStatus: 'LEGACY' }, correct, user, now, null).financeStatus).toBe(
      'PENDING_APPROVAL',
    );
  });
});

describe('formatInvoiceAccount', () => {
  it('shows code and name, or only the code without a name', () => {
    expect(formatInvoiceAccount('2.1.03', 'Fornecedores')).toBe('2.1.03 – Fornecedores');
    expect(formatInvoiceAccount('2.1.03', null)).toBe('2.1.03');
  });
});

describe('isValidChangeReason', () => {
  it('requires 10 to 500 characters after trim', () => {
    expect(isValidChangeReason('   123456789   ')).toBe(false);
    expect(isValidChangeReason('  1234567890  ')).toBe(true);
    expect(isValidChangeReason('x'.repeat(500))).toBe(true);
    expect(isValidChangeReason('x'.repeat(501))).toBe(false);
  });
});
