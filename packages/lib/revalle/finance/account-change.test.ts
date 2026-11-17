import { describe, expect, it } from 'vitest';

import {
  buildAccountChangeNotice,
  buildVersionChangeNotice,
  formatInvoiceAccount,
  type InvoiceFileVersionRow,
  isValidChangeReason,
  nextClassification,
  nextInvoiceFiles,
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

describe('versionChangeNoticeLine com várias notas', () => {
  const document = { index: 2, total: 3, title: 'nf-b.pdf' };

  it('diz a nota na troca de conta', () => {
    expect(
      versionChangeNoticeLine({
        kind: 'ACCOUNT',
        title: 'Compra',
        from: '2.1.03 – Fornecedores',
        to: '3.1.01 – Serviços de terceiros',
        document,
      }),
    ).toBe(
      'A conta contábil da nota fiscal Compra (nota 2 de 3: nf-b.pdf) foi alterada pelo Financeiro de 2.1.03 – Fornecedores para 3.1.01 – Serviços de terceiros.',
    );
    expect(versionChangeNoticeLine({ kind: 'ACCOUNT', title: 'Compra', from: null, to: '3.1.01', document })).toBe(
      'A conta contábil da nota fiscal Compra (nota 2 de 3: nf-b.pdf) foi definida pelo Financeiro: 3.1.01.',
    );
  });

  it('diz a nota na correção do centro', () => {
    expect(
      versionChangeNoticeLine({
        kind: 'COST_CENTER',
        fromCode: '101',
        toCode: '201',
        document: { index: 3, total: 3, title: 'nf-c.pdf' },
      }),
    ).toBe('O centro de custo da nota 3 de 3 (nf-c.pdf) foi corrigido de 101 – Puxada para 201 – Armazém.');
  });

  it('sem a nota, a frase de antes', () => {
    expect(versionChangeNoticeLine({ kind: 'ACCOUNT', title: 'NF 123', from: '2.1.03', to: '3.1.01' })).toBe(
      'A conta contábil da nota fiscal NF 123 foi alterada pelo Financeiro de 2.1.03 para 3.1.01.',
    );
  });
});

describe('nextInvoiceFiles', () => {
  const previousDay = new Date('2026-11-03T12:00:00.000Z');
  const now = new Date('2026-11-04T12:00:00.000Z');
  const user = { id: 9, name: '  Quem Mudou  ' };

  const note = (id: string, choiceCode: string, costCenterCode: string, approved: boolean) => ({
    id,
    kind: 'NF' as const,
    choiceCode,
    choiceById: 1,
    choiceAt: previousDay,
    acceptedSuggestion: true,
    costCenterCode,
    costCenterById: 1,
    costCenterAt: previousDay,
    costCenterValidatedAt: previousDay,
    costCenterValidatedById: 2,
    costCenterValidatedByName: 'Contabilidade',
    approvedById: approved ? 3 : null,
    approvedAt: approved ? previousDay : null,
    approvedAccountName: approved ? 'Fornecedores' : null,
    approvedByName: approved ? 'Financeiro' : null,
  });

  const boleto = {
    ...note('boleto', '', '', false),
    kind: 'BOLETO' as const,
    choiceCode: null,
    costCenterCode: null,
    acceptedSuggestion: null,
  };

  const strip = ({ id: _id, kind: _kind, ...columns }: InvoiceFileVersionRow) => columns;

  it('uma nota: igual a nextClassification (troca de conta aprovada por quem trocou)', () => {
    const a = note('a', '2.1.03', '101', false);
    const change = { kind: 'ACCOUNT', code: '3.1.01' } as const;
    const result = nextInvoiceFiles({
      files: [a, boleto],
      targetFileId: 'a',
      change,
      previousFinanceStatus: 'PENDING_APPROVAL',
      user,
      now,
      accountName: 'Serviços',
    });
    const { financeStatus, ...expected } = nextClassification(
      { ...a, financeStatus: 'PENDING_APPROVAL' },
      change,
      user,
      now,
      'Serviços',
    );

    expect(financeStatus).toBe('APPROVED');
    expect(result.financeStatus).toBe('APPROVED');
    expect(result.files.get('a')).toEqual({ ...strip(a), ...expected });
    expect(result.files.get('a')?.approvedById).toBe(9);
    expect(result.files.get('boleto')).toEqual(strip(boleto));
  });

  it('uma nota: a correção do centro copia a aprovação', () => {
    const a = note('a', '2.1.03', '101', true);
    const result = nextInvoiceFiles({
      files: [a],
      targetFileId: 'a',
      change: { kind: 'COST_CENTER', code: '201' },
      previousFinanceStatus: 'APPROVED',
      user,
      now,
      accountName: null,
    });

    expect(result.financeStatus).toBe('APPROVED');
    expect(result.files.get('a')).toEqual({
      ...strip(a),
      costCenterCode: '201',
      costCenterById: 9,
      costCenterAt: now,
      costCenterValidatedAt: now,
      costCenterValidatedById: 9,
      costCenterValidatedByName: 'Quem Mudou',
    });
  });

  const three = () => [
    note('a', '2.1.03', '101', true),
    note('b', '2.1.03', '201', false),
    note('c', '2.1.03', '301', true),
    boleto,
  ];

  const noApproval = { approvedById: null, approvedAt: null, approvedAccountName: null, approvedByName: null };

  it('três notas, troca da conta de b: todas aguardam o Financeiro, a e c com a conta e o centro de antes', () => {
    const files = three();
    const result = nextInvoiceFiles({
      files,
      targetFileId: 'b',
      change: { kind: 'ACCOUNT', code: '3.1.01' },
      previousFinanceStatus: 'PENDING_APPROVAL',
      user,
      now,
      accountName: 'Serviços',
    });

    expect(result.financeStatus).toBe('PENDING_APPROVAL');
    expect(result.files.get('a')).toEqual({ ...strip(files[0]), ...noApproval });
    expect(result.files.get('b')).toEqual({
      ...strip(files[1]),
      choiceCode: '3.1.01',
      choiceById: 9,
      choiceAt: now,
      ...noApproval,
    });
    expect(result.files.get('c')).toEqual({ ...strip(files[2]), ...noApproval });
    expect(result.files.get('boleto')).toEqual(strip(boleto));

    for (const id of ['a', 'b', 'c']) {
      expect(result.files.get(id)?.approvedAt).toBeNull();
    }
  });

  it('três notas, correção do centro de c: c validado por quem corrigiu, as validações de a e b ficam', () => {
    const files = three();
    const result = nextInvoiceFiles({
      files,
      targetFileId: 'c',
      change: { kind: 'COST_CENTER', code: '201' },
      previousFinanceStatus: 'APPROVED',
      user,
      now,
      accountName: null,
    });

    expect(result.financeStatus).toBe('PENDING_APPROVAL');
    expect(result.files.get('a')).toEqual({ ...strip(files[0]), ...noApproval });
    expect(result.files.get('b')).toEqual({ ...strip(files[1]), ...noApproval });
    expect(result.files.get('c')).toEqual({
      ...strip(files[2]),
      costCenterCode: '201',
      costCenterById: 9,
      costCenterAt: now,
      costCenterValidatedAt: now,
      costCenterValidatedById: 9,
      costCenterValidatedByName: 'Quem Mudou',
      ...noApproval,
    });
  });

  it('a nota alvo tem de ser uma nota do envio', () => {
    expect(() =>
      nextInvoiceFiles({
        files: three(),
        targetFileId: 'boleto',
        change: { kind: 'ACCOUNT', code: '3.1.01' },
        previousFinanceStatus: 'PENDING_APPROVAL',
        user,
        now,
        accountName: null,
      }),
    ).toThrow();
  });
});
