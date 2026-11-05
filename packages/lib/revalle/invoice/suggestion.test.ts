import { describe, expect, it } from 'vitest';

import { invoiceResponseSchema, validateSuggestion } from './suggestion';

const active = new Set(['2.1.03', '1.1.02']);
const NO_DATA = { supplierName: null, invoiceNumber: null, totalAmount: null, accessKey: null };

describe('validateSuggestion', () => {
  it('aceita sugestão de conta ativa', () => {
    const raw = { accountCode: '2.1.03', confidence: 'alta', reason: 'Compra de fornecedor' };

    expect(validateSuggestion(raw, active)).toEqual({ ...raw, ...NO_DATA });
  });

  it('aceita o JSON como texto', () => {
    const raw = JSON.stringify({ accountCode: '1.1.02', confidence: 'media', reason: 'Venda' });

    expect(validateSuggestion(raw, active)?.accountCode).toBe('1.1.02');
  });

  it('recusa conta que não existe na lista ativa', () => {
    expect(validateSuggestion({ accountCode: '9.9.99', confidence: 'alta', reason: 'x' }, active)).toBeNull();
  });

  it('corta o motivo em 200 caracteres', () => {
    const result = validateSuggestion({ accountCode: '2.1.03', confidence: 'baixa', reason: 'a'.repeat(300) }, active);

    expect(result?.reason).toHaveLength(200);
  });

  it('recusa JSON inválido e formatos errados', () => {
    expect(validateSuggestion('{não é json', active)).toBeNull();
    expect(validateSuggestion(null, active)).toBeNull();
    expect(validateSuggestion({ accountCode: '2.1.03', confidence: 'certeza', reason: 'x' }, active)).toBeNull();
    expect(validateSuggestion({ accountCode: '2.1.03', confidence: 'alta' }, active)).toBeNull();
  });
});

describe('validateSuggestion, dados da NF (Fase 8)', () => {
  const account = { accountCode: '2.1.03', confidence: 'alta', reason: 'Compra' };

  it('guarda os dados lidos já limpos, com o valor em reais', () => {
    const result = validateSuggestion(
      { ...account, supplierName: '  ACME LTDA ', invoiceNumber: 123, totalAmount: 1234.56, accessKey: null },
      active,
    );

    expect(result).toEqual({
      ...account,
      supplierName: 'ACME LTDA',
      invoiceNumber: '123',
      totalAmount: 1234.56,
      accessKey: null,
    });
  });

  it('campo novo de tipo errado ou faltando nunca faz perder a conta', () => {
    for (const extra of [
      { totalAmount: 'abc' },
      { supplierName: 5 },
      { totalAmount: -5, invoiceNumber: {}, accessKey: 12 },
      { accessKey: '123' },
      { supplierName: ['x'], invoiceNumber: true },
      {},
    ]) {
      const result = validateSuggestion({ ...account, ...extra }, active);

      expect(result?.accountCode).toBe('2.1.03');
      expect(result?.confidence).toBe('alta');
      expect(result?.reason).toBe('Compra');
    }

    expect(validateSuggestion({ ...account, totalAmount: 'abc', supplierName: 5 }, active)).toEqual({
      ...account,
      ...NO_DATA,
    });
  });

  it('o mesmo vale quando a resposta chega como texto', () => {
    const result = validateSuggestion(JSON.stringify({ ...account, totalAmount: 'R$ 10', supplierName: 5 }), active);

    expect(result).toEqual({ ...account, ...NO_DATA });
  });

  it('o que o servidor grava volta igual quando é lido do cache', () => {
    const stored = validateSuggestion({ ...account, supplierName: 'ACME', totalAmount: 0.1 + 0.2 }, active);

    expect(validateSuggestion(JSON.parse(JSON.stringify(stored)), active)).toEqual(stored);
    expect(stored?.totalAmount).toBe(0.3);
  });

  it('a conta fora da lista ativa continua sendo recusada', () => {
    expect(validateSuggestion({ ...account, accountCode: '9.9.99', supplierName: 'ACME' }, active)).toBeNull();
  });
});

describe('invoiceResponseSchema', () => {
  const suggestion = { accountCode: '340802', confidence: 'alta', reason: 'Frete' };

  it('só aceita código da lista', () => {
    const schema = invoiceResponseSchema(['340802', '341001']);

    expect(schema.safeParse(suggestion).success).toBe(true);
    expect(schema.safeParse({ ...suggestion, accountCode: '340108' }).success).toBe(false);
  });

  it('continua cortando o motivo em 200 caracteres', () => {
    const parsed = invoiceResponseSchema(['340802']).parse({ ...suggestion, reason: 'a'.repeat(300) });

    expect(parsed.reason).toHaveLength(200);
  });

  it('pede os quatro dados da NF como texto e número simples, todos opcionais e podendo ser nulos', () => {
    const schema = invoiceResponseSchema(['340802']);
    const full = { ...suggestion, supplierName: 'ACME', invoiceNumber: '12', totalAmount: 10.5, accessKey: null };

    expect(schema.safeParse(full).success).toBe(true);
    expect(schema.safeParse({ ...suggestion, supplierName: null, invoiceNumber: null }).success).toBe(true);
    expect(schema.safeParse(suggestion).success).toBe(true);
    // O que vai ao Gemini é estrito: tipo errado não passa (a leitura do texto bruto é que é tolerante).
    expect(schema.safeParse({ ...suggestion, totalAmount: 'abc' }).success).toBe(false);
    expect(schema.safeParse({ ...suggestion, supplierName: 5 }).success).toBe(false);
  });

  it('solta a trava quando a lista passa do que o Gemini aceita', () => {
    const codes = Array.from({ length: 5000 }, (_, index) => `3.4.01.${String(index).padStart(8, '0')}`);

    expect(invoiceResponseSchema(codes).safeParse({ ...suggestion, accountCode: '340108' }).success).toBe(true);
  });

  it('não trava com lista vazia', () => {
    expect(invoiceResponseSchema([]).safeParse(suggestion).success).toBe(true);
  });
});
