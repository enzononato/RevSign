import { describe, expect, it } from 'vitest';

import { toBrazilianStateCode } from './br-states';

describe('toBrazilianStateCode', () => {
  it('converte nomes (com e sem acento, em pt-BR ou en)', () => {
    expect(toBrazilianStateCode('Bahia')).toBe('BA');
    expect(toBrazilianStateCode('São Paulo')).toBe('SP');
    expect(toBrazilianStateCode('Ceará')).toBe('CE');
    expect(toBrazilianStateCode('State of Rio de Janeiro')).toBe('RJ');
    expect(toBrazilianStateCode('Federal District')).toBe('DF');
  });

  it('mantém siglas e devolve o nome desconhecido como veio', () => {
    expect(toBrazilianStateCode('pe')).toBe('PE');
    expect(toBrazilianStateCode('Atlantida')).toBe('Atlantida');
  });
});
