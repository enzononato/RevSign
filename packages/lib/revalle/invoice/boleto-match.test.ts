import { describe, expect, it } from 'vitest';

import type { BoletoData } from './boleto';
import { boletoWarningMessage, checkBoleto, issuerCnpjFromAccessKey } from './boleto-match';

const today = '2026-11-16';

const boleto = (overrides: Partial<BoletoData> = {}): BoletoData => ({
  beneficiaryName: null,
  beneficiaryCnpj: null,
  amountCents: 150000,
  dueDate: '2026-12-01',
  digitableLine: null,
  ...overrides,
});

const nf = (totalAmountCents: number | null, issuerCnpj: string | null = null, supplierName: string | null = null) => ({
  totalAmountCents,
  issuerCnpj,
  supplierName,
});

describe('checkBoleto: valor', () => {
  it('igual a uma nota ou à soma das notas não avisa', () => {
    expect(checkBoleto({ boleto: boleto(), otherBoletoAmounts: [], invoices: [nf(90000), nf(150000)], today })).toEqual(
      [],
    );
    expect(checkBoleto({ boleto: boleto(), otherBoletoAmounts: [], invoices: [nf(100000), nf(50000)], today })).toEqual(
      [],
    );
  });

  it('parcelas que somam a nota não avisam', () => {
    expect(
      checkBoleto({
        boleto: boleto({ amountCents: 100000 }),
        otherBoletoAmounts: [100000, 100000],
        invoices: [nf(300000)],
        today,
      }),
    ).toEqual([]);
    expect(
      checkBoleto({
        boleto: boleto({ amountCents: 100000 }),
        otherBoletoAmounts: [100000],
        invoices: [nf(100000), nf(100000)],
        today,
      }),
    ).toEqual([]);
  });

  it('valor que não bate com nada avisa, com o valor do boleto', () => {
    expect(
      checkBoleto({ boleto: boleto({ amountCents: 149900 }), otherBoletoAmounts: [], invoices: [nf(150000)], today }),
    ).toEqual([{ code: 'AMOUNT_MISMATCH', amountCents: 149900 }]);
    expect(
      checkBoleto({
        boleto: boleto({ amountCents: 100000 }),
        otherBoletoAmounts: [90000],
        invoices: [nf(300000)],
        today,
      }),
    ).toEqual([{ code: 'AMOUNT_MISMATCH', amountCents: 100000 }]);
  });

  it('sem valor numa nota nem no boleto, não avisa do valor', () => {
    expect(
      checkBoleto({ boleto: boleto({ amountCents: 1 }), otherBoletoAmounts: [], invoices: [nf(null)], today }),
    ).toEqual([]);
    expect(
      checkBoleto({ boleto: boleto({ amountCents: null }), otherBoletoAmounts: [], invoices: [nf(150000)], today }),
    ).toEqual([]);
  });
});

describe('checkBoleto: beneficiário', () => {
  it('compara a raiz do CNPJ (a filial é o mesmo emitente)', () => {
    expect(
      checkBoleto({
        boleto: boleto({ beneficiaryCnpj: '12345678000276' }),
        otherBoletoAmounts: [],
        invoices: [nf(150000, '12345678000195')],
        today,
      }),
    ).toEqual([]);
    expect(
      checkBoleto({
        boleto: boleto({ beneficiaryCnpj: '98765432000198' }),
        otherBoletoAmounts: [],
        invoices: [nf(150000, '12345678000195')],
        today,
      }),
    ).toEqual([{ code: 'BENEFICIARY_MISMATCH' }]);
  });

  it('sem CNPJ, compara o nome sem acento, caixa nem pontuação', () => {
    expect(
      checkBoleto({
        boleto: boleto({ beneficiaryName: 'ACME COMERCIO LTDA' }),
        otherBoletoAmounts: [],
        invoices: [nf(150000, null, 'Acme Comércio Ltda.')],
        today,
      }),
    ).toEqual([]);
    expect(
      checkBoleto({
        boleto: boleto({ beneficiaryName: 'ACME COMERCIO LTDA' }),
        otherBoletoAmounts: [],
        invoices: [nf(150000, null, 'Beta Distribuidora')],
        today,
      }),
    ).toEqual([{ code: 'BENEFICIARY_MISMATCH' }]);
  });

  it('basta bater com uma das notas; sem dado dos dois lados, não avisa', () => {
    expect(
      checkBoleto({
        boleto: boleto({ beneficiaryCnpj: '98765432000198' }),
        otherBoletoAmounts: [],
        invoices: [nf(150000, '12345678000195'), nf(10000, '98765432000198')],
        today,
      }),
    ).toEqual([]);
    expect(
      checkBoleto({
        boleto: boleto({ beneficiaryCnpj: '98765432000198' }),
        otherBoletoAmounts: [],
        invoices: [nf(150000, null, 'Acme')],
        today,
      }),
    ).toEqual([]);
  });
});

describe('checkBoleto: vencimento', () => {
  it('vencido só antes de hoje', () => {
    expect(
      checkBoleto({ boleto: boleto({ dueDate: '2026-11-15' }), otherBoletoAmounts: [], invoices: [nf(150000)], today }),
    ).toEqual([{ code: 'OVERDUE', dueDate: '2026-11-15' }]);
    expect(
      checkBoleto({ boleto: boleto({ dueDate: '2026-11-16' }), otherBoletoAmounts: [], invoices: [nf(150000)], today }),
    ).toEqual([]);
  });
});

it('as mensagens dos avisos', () => {
  expect(boletoWarningMessage({ code: 'AMOUNT_MISMATCH', amountCents: 149900 })).toBe(
    'O valor do boleto (R$ 1.499,00) não bate com nenhuma nota do envio.',
  );
  expect(boletoWarningMessage({ code: 'BENEFICIARY_MISMATCH' })).toBe(
    'O beneficiário do boleto é diferente do emitente das notas.',
  );
  expect(boletoWarningMessage({ code: 'OVERDUE', dueDate: '2026-11-15' })).toBe('Boleto vencido em 15/11/2026.');
});

it('o CNPJ do emitente vem da chave de acesso', () => {
  expect(issuerCnpjFromAccessKey('29241012345678000195550010000123451123456784')).toBe('12345678000195');
  expect(issuerCnpjFromAccessKey('2924101234')).toBeNull();
});
