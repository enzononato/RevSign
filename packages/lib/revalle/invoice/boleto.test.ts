import { describe, expect, it } from 'vitest';

import {
  BOLETO_PROMPT,
  detectBoleto,
  mergeBoletoData,
  normalizeBoletoData,
  parseDigitableLine,
  readStoredBoletoData,
} from './boleto';

const ref = new Date('2026-11-16T12:00:00Z');

describe('parseDigitableLine', () => {
  it('lê banco, valor e vencimento de uma linha com os dígitos certos', () => {
    expect(parseDigitableLine('34191.09123 34567.812341 56789.012301 1 16470000150000', ref)).toEqual({
      bankCode: '341',
      amountCents: 150000,
      dueDate: '2026-12-01',
    });
    expect(parseDigitableLine('34191091233456781234156789012301616470000149900', ref)?.amountCents).toBe(149900);
  });

  it('escolhe, entre as duas bases do fator, o vencimento mais perto da referência', () => {
    expect(parseDigitableLine('34191.09123 34567.812341 56789.012301 4 97120000012345', ref)?.dueDate).toBe(
      '2024-05-10',
    );
    expect(parseDigitableLine('34191.09123 34567.812341 56789.012301 6 99990000150000', ref)?.dueDate).toBe(
      '2025-02-21',
    );
    expect(parseDigitableLine('34191.09123 34567.812341 56789.012301 1 10000000150000', ref)?.dueDate).toBe(
      '2025-02-22',
    );
  });

  it('recusa a linha com o dígito geral ou o de um campo errado', () => {
    expect(parseDigitableLine('34191.09123 34567.812341 56789.012301 2 16470000150000', ref)).toBeNull();
    expect(parseDigitableLine('34191.09124 34567.812341 56789.012301 1 16470000150000', ref)).toBeNull();
    expect(parseDigitableLine('3419109123345678123415678901230161647000014990', ref)).toBeNull();
  });

  it('fator zero = sem vencimento; valor zero = sem valor', () => {
    const parsed = parseDigitableLine('34191.09123 34567.812341 56789.012301 8 00000000000000', ref);

    expect(parsed).toEqual({ bankCode: '341', amountCents: null, dueDate: null });
  });
});

describe('detectBoleto', () => {
  it('reconhece o boleto pelas marcas do texto (três ou mais)', () => {
    expect(detectBoleto(['Ficha de Compensação', 'Beneficiário ACME', 'Vencimento 01/12/2026']).isBoleto).toBe(true);
    expect(detectBoleto(['Contrato de prestação de serviços']).isBoleto).toBe(false);
    expect(detectBoleto(['Vencimento 01/12/2026', 'Beneficiário ACME']).isBoleto).toBe(false);
  });

  it('reconhece o boleto pela linha digitável válida e a devolve só com os dígitos', () => {
    expect(detectBoleto(['Pague até o dia', '34191.09123 34567.812341 56789.012301 1 16470000150000'])).toEqual({
      isBoleto: true,
      digitableLine: '34191091233456781234156789012301116470000150000',
    });
    expect(detectBoleto(['34191.09123 34567.812341 56789.012301 2 16470000150000'])).toEqual({
      isBoleto: false,
      digitableLine: null,
    });
  });
});

describe('normalizeBoletoData', () => {
  it('limpa o CNPJ, converte o valor e aceita só a data AAAA-MM-DD', () => {
    expect(
      normalizeBoletoData({ beneficiaryCnpj: '12.345.678/0001-95', amount: 1500, dueDate: '2026-12-01' }),
    ).toMatchObject({ beneficiaryCnpj: '12345678000195', amountCents: 150000, dueDate: '2026-12-01' });
    expect(normalizeBoletoData({ beneficiaryCnpj: '12345678000199', dueDate: '01/12/2026' })).toMatchObject({
      beneficiaryCnpj: null,
      dueDate: null,
    });
    expect(normalizeBoletoData({ dueDate: '2026-02-30' }).dueDate).toBeNull();
  });

  it('nunca lança e mascara o CPF do nome', () => {
    expect(normalizeBoletoData('isto não é JSON')).toEqual({
      beneficiaryName: null,
      beneficiaryCnpj: null,
      amountCents: null,
      dueDate: null,
      digitableLine: null,
    });
    expect(normalizeBoletoData({ beneficiaryName: 'MARIA SOUZA 12345678909' }).beneficiaryName).toBe(
      'MARIA SOUZA ***.***.***-**',
    );
  });

  it('a linha digitável da IA só vale com os dígitos conferidos', () => {
    expect(
      normalizeBoletoData({ digitableLine: '34191.09123 34567.812341 56789.012301 1 16470000150000' }).digitableLine,
    ).toBe('34191091233456781234156789012301116470000150000');
    expect(
      normalizeBoletoData({ digitableLine: '34191.09123 34567.812341 56789.012301 2 16470000150000' }).digitableLine,
    ).toBeNull();
  });
});

describe('mergeBoletoData', () => {
  it('a linha digitável vence a IA no valor, no vencimento e na linha', () => {
    expect(
      mergeBoletoData(
        { amountCents: 150000, dueDate: '2026-12-01', digitableLine: 'L' },
        { beneficiaryName: 'ACME', beneficiaryCnpj: null, amountCents: 1, dueDate: '2030-01-01', digitableLine: null },
      ),
    ).toEqual({
      beneficiaryName: 'ACME',
      beneficiaryCnpj: null,
      amountCents: 150000,
      dueDate: '2026-12-01',
      digitableLine: 'L',
    });
  });

  it('o que a linha não tem vem da IA; sem nada, tudo vazio', () => {
    expect(
      mergeBoletoData(
        { amountCents: null, dueDate: null, digitableLine: 'L' },
        { beneficiaryName: null, beneficiaryCnpj: null, amountCents: 900, dueDate: '2030-01-01', digitableLine: 'X' },
      ),
    ).toMatchObject({ amountCents: 900, dueDate: '2030-01-01', digitableLine: 'L' });
    expect(mergeBoletoData(null, null)).toEqual({
      beneficiaryName: null,
      beneficiaryCnpj: null,
      amountCents: null,
      dueDate: null,
      digitableLine: null,
    });
  });
});

describe('readStoredBoletoData', () => {
  it('lê o que foi gravado e recusa o que não tem a forma', () => {
    const stored = {
      beneficiaryName: 'ACME',
      beneficiaryCnpj: null,
      amountCents: 150000,
      dueDate: '2026-12-01',
      digitableLine: null,
    };

    expect(readStoredBoletoData(stored)).toEqual(stored);
    expect(readStoredBoletoData(null)).toBeNull();
    expect(readStoredBoletoData({ amountCents: '150000' })).toMatchObject({ amountCents: null });
  });
});

it('o pedido do boleto não leva a lista de contas', () => {
  expect(BOLETO_PROMPT).toContain('"dueDate"');
  expect(BOLETO_PROMPT).not.toContain('Contas contábeis');
});
