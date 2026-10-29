import { describe, expect, it } from 'vitest';

import { mapColaboradorRow } from './map-row';

const baseRow = {
  cpf: '390.533.447-05',
  nome: 'Maria Teste da Silva',
  data_nascimento: '1990-03-07',
  cargo: 'Analista',
  setor: 'RH',
  unidade: 'Juazeiro',
  matricula: '1001',
  email: ' X@Revalle.com.br ',
  telefone: null,
  situacao: 'ativo',
};

describe('mapColaboradorRow', () => {
  it('keeps only digits in the CPF', () => {
    expect(mapColaboradorRow(baseRow).cpf).toBe('39053344705');
  });

  it('trims and lowercases the e-mail', () => {
    expect(mapColaboradorRow(baseRow).email).toBe('x@revalle.com.br');
  });

  it('keeps a null e-mail as null', () => {
    expect(mapColaboradorRow({ ...baseRow, email: null }).email).toBeNull();
  });

  it('maps the remaining fields', () => {
    expect(mapColaboradorRow(baseRow)).toMatchObject({
      nome: 'Maria Teste da Silva',
      dataNascimento: '1990-03-07',
      unidade: 'Juazeiro',
      telefone: null,
      situacao: 'ativo',
    });
  });
});
