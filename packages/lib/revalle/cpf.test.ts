import { describe, expect, it } from 'vitest';

import { isValidCpf, maskCpf, normalizeCpf } from './cpf';

describe('normalizeCpf', () => {
  it('keeps only the digits of a formatted CPF', () => {
    expect(normalizeCpf('529.982.247-25')).toBe('52998224725');
  });
});

describe('isValidCpf', () => {
  it('accepts a CPF whose check digits match, formatted or not', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
  });

  it('rejects a CPF with wrong check digits', () => {
    expect(isValidCpf('529.982.247-24')).toBe(false);
  });

  it('rejects a repeated-digit sequence even when its check digits compute', () => {
    expect(isValidCpf('111.111.111-11')).toBe(false);
  });

  it('rejects a CPF with the wrong length', () => {
    expect(isValidCpf('5299822472')).toBe(false);
  });
});

describe('maskCpf', () => {
  it('hides everything except the middle six digits', () => {
    expect(maskCpf('52998224725')).toBe('***.982.247-**');
    expect(maskCpf('12345678909')).toBe('***.456.789-**');
  });
});
