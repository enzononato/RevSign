import { describe, expect, it } from 'vitest';

import {
  greetingName,
  hrNameChange,
  isBlankName,
  keepPersistedName,
  nameFromAccount,
  toAccountNameMap,
} from './recipient-name';

describe('toAccountNameMap', () => {
  it('ignora conta sem nome ou com nome em branco e normaliza o e-mail', () => {
    const names = toAccountNameMap([
      { email: 'Ana@Revalle.com.br', name: '  Ana Souza ' },
      { email: 'sem-nome@revalle.com.br', name: null },
      { email: 'branco@revalle.com.br', name: '   ' },
    ]);

    expect([...names]).toEqual([['ana@revalle.com.br', 'Ana Souza']]);
  });
});

describe('nameFromAccount', () => {
  const names = toAccountNameMap([{ email: 'ana@revalle.com.br', name: 'Ana Souza' }]);

  it('preenche o nome vazio com o da conta (e-mail sem diferença de maiúsculas)', () => {
    expect(nameFromAccount('', 'ANA@revalle.com.br', names)).toBe('Ana Souza');
    expect(nameFromAccount('   ', 'ana@revalle.com.br', names)).toBe('Ana Souza');
    expect(nameFromAccount(undefined, 'ana@revalle.com.br', names)).toBe('Ana Souza');
  });

  it('nunca troca um nome que já existe, mesmo de outra conta', () => {
    expect(nameFromAccount('Nome Antigo', 'ana@revalle.com.br', names)).toBe('Nome Antigo');
  });

  it('sem conta, o nome continua vazio (nunca "null")', () => {
    expect(nameFromAccount('', 'outra@gmail.com', names)).toBe('');
    expect(nameFromAccount(null, 'outra@gmail.com', names)).toBe('');
    expect(nameFromAccount('', null, names)).toBe('');
  });
});

describe('hrNameChange', () => {
  it('troca pelo nome do RH, com o nome antigo', () => {
    expect(hrNameChange('Ana', 'Ana Fictícia Souza')).toEqual({ from: 'Ana', to: 'Ana Fictícia Souza' });
  });

  it('sem nome antes, `from` é null', () => {
    expect(hrNameChange('', 'Ana Fictícia Souza')).toEqual({ from: null, to: 'Ana Fictícia Souza' });
    expect(hrNameChange('  ', ' Ana Fictícia Souza ')).toEqual({ from: null, to: 'Ana Fictícia Souza' });
  });

  it('nome igual (portão de novo) ou RH sem nome: nada a trocar', () => {
    expect(hrNameChange('Ana Fictícia Souza', 'Ana Fictícia Souza ')).toBeNull();
    expect(hrNameChange('Ana', '')).toBeNull();
    expect(hrNameChange('Ana', null)).toBeNull();
    expect(hrNameChange('Ana', '   ')).toBeNull();
  });

  it('corta no tamanho da coluna', () => {
    expect(hrNameChange('', 'x'.repeat(300))?.to).toHaveLength(255);
  });
});

describe('greetingName', () => {
  it('usa o e-mail quando ainda não há nome', () => {
    expect(greetingName('', 'ana@gmail.com')).toBe('ana@gmail.com');
    expect(greetingName('  ', 'ana@gmail.com')).toBe('ana@gmail.com');
    expect(greetingName(' Ana ', 'ana@gmail.com')).toBe('Ana');
  });

  it('isBlankName', () => {
    expect(isBlankName(null)).toBe(true);
    expect(isBlankName(' ')).toBe(true);
    expect(isBlankName('Ana')).toBe(false);
  });
});

describe('keepPersistedName', () => {
  const persisted = { name: 'Maria Teste da Silva', email: 'maria@gmail.com' };

  it('nome vazio para o mesmo e-mail fica o gravado', () => {
    expect(keepPersistedName({ name: '', email: 'MARIA@gmail.com' }, persisted)).toBe('Maria Teste da Silva');
    expect(keepPersistedName({ name: '  ', email: 'maria@gmail.com' }, persisted)).toBe('Maria Teste da Silva');
  });

  it('e-mail trocado: o nome vazio continua vazio', () => {
    expect(keepPersistedName({ name: '', email: 'outra@gmail.com' }, persisted)).toBe('');
  });

  it('nome informado ou destinatário novo: o informado', () => {
    expect(keepPersistedName({ name: 'Outro', email: 'maria@gmail.com' }, persisted)).toBe('Outro');
    expect(keepPersistedName({ name: '', email: 'maria@gmail.com' }, undefined)).toBe('');
    expect(keepPersistedName({ name: '', email: 'maria@gmail.com' }, { name: '', email: 'maria@gmail.com' })).toBe('');
  });

  it('portão já passou (nome do RH): o nome gravado fica mesmo com outro nome, se o e-mail é o mesmo', () => {
    expect(keepPersistedName({ name: 'Nome Velho', email: 'maria@gmail.com' }, persisted, { hrConfirmed: true })).toBe(
      'Maria Teste da Silva',
    );
    expect(keepPersistedName({ name: 'Nome Velho', email: 'outra@gmail.com' }, persisted, { hrConfirmed: true })).toBe(
      'Nome Velho',
    );
  });
});
