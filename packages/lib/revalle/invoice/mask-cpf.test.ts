import { describe, expect, it } from 'vitest';

import { CPF_MASK, maskCpf } from './mask-cpf';

describe('maskCpf', () => {
  it('mascara CPF formatado em qualquer lugar do texto', () => {
    expect(maskCpf('Transportador João, 123.456.789-09, placa ABC')).toBe(`Transportador João, ${CPF_MASK}, placa ABC`);
  });

  it('mascara 11 dígitos logo depois de "CPF" (com ou sem dois-pontos e nº)', () => {
    expect(maskCpf('CPF: 12345678909')).toBe(`CPF: ${CPF_MASK}`);
    expect(maskCpf('cpf nº 98765432100 e mais')).toBe(`cpf nº ${CPF_MASK} e mais`);
    expect(maskCpf('CPF 98765432100')).toBe(`CPF ${CPF_MASK}`);
  });

  it('não mexe em CNPJ, chave de acesso nem 11 dígitos sem o rótulo CPF', () => {
    const text = 'CNPJ 12.345.678/0001-95 chave 29241012345678000195550010000123451123456784 pedido 12345678909';

    expect(maskCpf(text)).toBe(text);
  });

  it('mascara 11 dígitos depois do rótulo "CPF/CNPJ" (tomador da NFS-e)', () => {
    expect(maskCpf('CPF/CNPJ: 12345678909')).toBe(`CPF/CNPJ: ${CPF_MASK}`);
    expect(maskCpf('CPF / CNPJ 12345678909 Nome')).toBe(`CPF / CNPJ ${CPF_MASK} Nome`);
    expect(maskCpf('cpf/cnpj nº 12345678909')).toBe(`cpf/cnpj nº ${CPF_MASK}`);
    expect(maskCpf('CPF-12345678909')).toBe(`CPF-${CPF_MASK}`);
  });

  it('mascara CPF com só o hífen (123456789-01) ou pontuação parcial, com ou sem rótulo', () => {
    expect(maskCpf('CPF: 123456789-01')).toBe(`CPF: ${CPF_MASK}`);
    expect(maskCpf('tomador 123456789-01 rua')).toBe(`tomador ${CPF_MASK} rua`);
    expect(maskCpf('CPF/CNPJ: 123.456789-01')).toBe(`CPF/CNPJ: ${CPF_MASK}`);
    expect(maskCpf('123456.789-01')).toBe(CPF_MASK);
  });

  it('nunca mexe em CNPJ de 14 dígitos nem na chave de 44, mesmo depois de "CPF/CNPJ"', () => {
    for (const text of [
      'CPF/CNPJ: 12345678000195',
      'CPF/CNPJ: 12.345.678/0001-95',
      'CPF / CNPJ 12345678000195',
      'CPF 12345678000195',
      'CNPJ 12345678000195',
      'Chave de acesso 29241012345678000195550010000123451123456784',
      'CPF/CNPJ 29241012345678000195550010000123451123456784',
      '2924 1012 3456 7800 0195 5500 1000 0123 4511 2345 6784',
      '12345678000195-01',
    ]) {
      expect(maskCpf(text)).toBe(text);
    }
  });

  it('não corta números maiores que contêm o padrão', () => {
    expect(maskCpf('CPF 123456789091')).toBe('CPF 123456789091');
    expect(maskCpf('1123.456.789-09')).toBe('1123.456.789-09');
    expect(maskCpf('1123456789-09')).toBe('1123456789-09');
    expect(maskCpf('123456789-012')).toBe('123456789-012');
  });
});
