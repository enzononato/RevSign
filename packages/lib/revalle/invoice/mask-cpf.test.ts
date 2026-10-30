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

  it('não corta números maiores que contêm o padrão', () => {
    expect(maskCpf('CPF 123456789091')).toBe('CPF 123456789091');
    expect(maskCpf('1123.456.789-09')).toBe('1123.456.789-09');
  });
});
