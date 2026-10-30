import { describe, expect, it } from 'vitest';

import {
  buildAccountChangeNotice,
  formatInvoiceAccount,
  isValidChangeReason,
  nextVersionTitle,
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

  it('does not double the final punctuation of the reason', () => {
    expect(buildAccountChangeNotice({ ...base, reason: 'Conta de serviço, não de material.' })).toMatch(
      /Motivo: Conta de serviço, não de material\.$/,
    );
    expect(buildAccountChangeNotice({ ...base, reason: 'Era serviço!' })).toMatch(/Motivo: Era serviço!$/);
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
