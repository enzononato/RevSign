import { describe, expect, it } from 'vitest';

import { searchAccounts } from './account-search';

const ACCOUNTS = [
  { code: '2.1.03', name: 'Fornecedores' },
  { code: '3.1.01', name: 'Serviços de terceiros' },
  { code: '1.1.01', name: 'CAIXA' },
];

const codes = (query: string) => searchAccounts(ACCOUNTS, query).map((account) => account.code);

describe('searchAccounts', () => {
  it('encontra pelo nome sem diferenciar acento nem maiúscula', () => {
    expect(codes('servico')).toEqual(['3.1.01']);
    expect(codes('SERVIÇOS')).toEqual(['3.1.01']);
    expect(codes('caixa')).toEqual(['1.1.01']);
  });

  it('encontra pelo número, com ou sem os pontos', () => {
    expect(codes('2.1.0')).toEqual(['2.1.03']);
    expect(codes('2103')).toEqual(['2.1.03']);
    expect(codes(' 1.01 ')).toEqual(['3.1.01', '1.1.01']);
  });

  it('busca vazia devolve todas; sem resultado devolve lista vazia', () => {
    expect(codes('  ')).toEqual(['2.1.03', '3.1.01', '1.1.01']);
    expect(codes('aluguel')).toEqual([]);
  });

  it('texto com letras não vira busca por dígitos', () => {
    expect(codes('a1')).toEqual([]);
  });
});
