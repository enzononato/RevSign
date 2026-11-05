import { describe, expect, it } from 'vitest';

import {
  EMPTY_INVOICE_DATA,
  formatInvoiceAmount,
  formatInvoiceAmountCsv,
  formatInvoiceDataLine,
  normalizeInvoiceData,
} from './invoice-data';

// Chave fictícia de 44 dígitos com UF, mês, CNPJ, modelo 55 e dígito verificador certos.
const VALID_KEY = '29241012345678000195550010000123451123456784';

describe('normalizeInvoiceData', () => {
  it('aparam o texto, aceitam o número da nota como número e guardam o valor em centavos', () => {
    expect(
      normalizeInvoiceData({ supplierName: '  ACME LTDA ', invoiceNumber: 123, totalAmount: 1234.56, accessKey: null }),
    ).toEqual({ supplierName: 'ACME LTDA', invoiceNumber: '123', totalAmountCents: 123456, accessKey: null });
  });

  it('valor fora do que é possível pagar fica vazio', () => {
    for (const totalAmount of ['abc', '1234.56', -5, 0, 0.004, 21474836.48, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(normalizeInvoiceData({ totalAmount }).totalAmountCents).toBeNull();
    }
  });

  it('o limite de cima é o maior inteiro que a coluna guarda', () => {
    expect(normalizeInvoiceData({ totalAmount: 21474836.47 }).totalAmountCents).toBe(2147483647);
    expect(normalizeInvoiceData({ totalAmount: 0.01 }).totalAmountCents).toBe(1);
  });

  it('arredonda a conta de ponto flutuante para o centavo certo', () => {
    expect(normalizeInvoiceData({ totalAmount: 0.1 + 0.2 }).totalAmountCents).toBe(30);
    expect(normalizeInvoiceData({ totalAmount: 1234.56 }).totalAmountCents).toBe(123456);
  });

  it('corta o fornecedor em 200 e o número em 60 caracteres', () => {
    expect(normalizeInvoiceData({ supplierName: 'a'.repeat(300) }).supplierName).toHaveLength(200);
    expect(normalizeInvoiceData({ invoiceNumber: 'b'.repeat(90) }).invoiceNumber).toHaveLength(60);
  });

  it('o corte não parte um caractere de dois códigos ao meio', () => {
    const cut = normalizeInvoiceData({ supplierName: '😀'.repeat(250) }).supplierName ?? '';

    expect(Array.from(cut)).toHaveLength(200);
    expect(JSON.parse(JSON.stringify(cut))).toBe(cut);
  });

  it('tira caracteres de controle e troca quebras de linha por espaço', () => {
    expect(normalizeInvoiceData({ supplierName: 'A\u0000B\nC' }).supplierName).toBe('AB C');
    expect(normalizeInvoiceData({ supplierName: ' A \t\r\n  B ' }).supplierName).toBe('A B');
  });

  it('tira os caracteres que invertem o sentido do texto e o par solto de um caractere de dois códigos', () => {
    expect(normalizeInvoiceData({ supplierName: 'ACME‮atad' }).supplierName).toBe('ACMEatad');
    expect(normalizeInvoiceData({ supplierName: 'A\uD83DB' }).supplierName).toBe('AB');
  });

  it('o texto que parece fórmula fica como está: a planilha é quem neutraliza', () => {
    expect(normalizeInvoiceData({ supplierName: '=HYPERLINK("x")' }).supplierName).toBe('=HYPERLINK("x")');
  });

  it('texto vazio, só de espaços ou de tipo errado fica vazio', () => {
    expect(normalizeInvoiceData({ supplierName: '   ', invoiceNumber: '\u0000' })).toEqual(EMPTY_INVOICE_DATA);
    expect(normalizeInvoiceData({ supplierName: 5, invoiceNumber: {}, accessKey: 7 })).toEqual(EMPTY_INVOICE_DATA);
    expect(normalizeInvoiceData({ invoiceNumber: -3 }).invoiceNumber).toBeNull();
    expect(normalizeInvoiceData({ invoiceNumber: 1.5 }).invoiceNumber).toBeNull();
  });

  it('a chave só vale com 44 dígitos e o dígito verificador certo', () => {
    expect(normalizeInvoiceData({ accessKey: '123' }).accessKey).toBeNull();
    expect(normalizeInvoiceData({ accessKey: `${VALID_KEY.slice(0, 43)}0` }).accessKey).toBeNull();
    expect(normalizeInvoiceData({ accessKey: VALID_KEY }).accessKey).toBe(VALID_KEY);
    expect(normalizeInvoiceData({ accessKey: VALID_KEY.replace(/(\d{4})(?=\d)/g, '$1 ') }).accessKey).toBe(VALID_KEY);
  });

  it('nunca lança, seja qual for a entrada', () => {
    for (const raw of [null, undefined, 5, 'texto', [], [1], { totalAmount: Symbol.iterator }]) {
      expect(normalizeInvoiceData(raw)).toEqual(EMPTY_INVOICE_DATA);
    }

    expect(EMPTY_INVOICE_DATA).toEqual({
      supplierName: null,
      invoiceNumber: null,
      totalAmountCents: null,
      accessKey: null,
    });
  });
});

describe('formatInvoiceAmount', () => {
  it('escreve em reais, com ponto nos milhares e vírgula nos centavos', () => {
    expect(formatInvoiceAmount(123456)).toBe('R$ 1.234,56');
    expect(formatInvoiceAmount(5)).toBe('R$ 0,05');
    expect(formatInvoiceAmount(100)).toBe('R$ 1,00');
    expect(formatInvoiceAmount(2147483647)).toBe('R$ 21.474.836,47');
  });

  it('a planilha leva só os dígitos e a vírgula', () => {
    expect(formatInvoiceAmountCsv(123456)).toBe('1234,56');
    expect(formatInvoiceAmountCsv(5)).toBe('0,05');
    expect(formatInvoiceAmountCsv(2147483647)).toBe('21474836,47');
  });
});

describe('formatInvoiceDataLine', () => {
  it('junta só o que existe', () => {
    expect(formatInvoiceDataLine({ supplierName: 'ACME', invoiceNumber: '12', totalAmountCents: 150000 })).toBe(
      'ACME · Nº 12 · R$ 1.500,00',
    );
    expect(formatInvoiceDataLine({ supplierName: null, invoiceNumber: '12', totalAmountCents: null })).toBe('Nº 12');
    expect(formatInvoiceDataLine({ supplierName: 'ACME', invoiceNumber: null, totalAmountCents: 5 })).toBe(
      'ACME · R$ 0,05',
    );
    expect(formatInvoiceDataLine({ supplierName: null, invoiceNumber: null, totalAmountCents: null })).toBeNull();
    expect(formatInvoiceDataLine(null)).toBeNull();
  });
});
