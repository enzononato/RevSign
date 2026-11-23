import { describe, expect, it } from 'vitest';

import {
  estimateSendHours,
  isInactiveSituacao,
  parseCollaboratorTable,
  parseCollaboratorText,
} from './collaborator-rows';

describe('parseCollaboratorText', () => {
  it('lê colagem separada por tab com cabeçalho', () => {
    const rows = parseCollaboratorText(
      'Nome\tE-mail\tCPF\nAna\tana@x.com\t123.456.789-09\nBia\tbia@x.com\t98765432100',
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ line: 2, name: 'Ana', email: 'ana@x.com', cpf: '12345678909' });
  });

  it('sem cabeçalho assume nome, e-mail, cpf', () => {
    expect(parseCollaboratorText('Ana;ana@x.com;12345678909')).toEqual([
      { line: 1, name: 'Ana', email: 'ana@x.com', cpf: '12345678909' },
    ]);
  });

  it('respeita a ordem do cabeçalho', () => {
    expect(parseCollaboratorText('CPF;Nome;Email\n12345678909;Ana;ana@x.com')[0]).toMatchObject({
      name: 'Ana',
      email: 'ana@x.com',
      cpf: '12345678909',
    });
  });

  it('ignora linhas vazias e aceita vírgula', () => {
    const rows = parseCollaboratorText('\nAna,ana@x.com,12345678909\n\n  \nBia,bia@x.com,98765432100\n');

    expect(rows.map((row) => row.line)).toEqual([2, 5]);
  });

  it('lança ROW_LIMIT acima de 3000 linhas', () => {
    const text = Array.from({ length: 3001 }, (_, i) => `N${i};n${i}@x.com;12345678909`).join('\n');

    expect(() => parseCollaboratorText(text)).toThrow('ROW_LIMIT');
  });
});

describe('parseCollaboratorTable', () => {
  it('detecta cabeçalho com acento e caixa', () => {
    expect(
      parseCollaboratorTable([
        ['E-MAIL', 'Nôme', 'cpf'],
        ['a@x.com', 'Ana', '123.456.789-09'],
      ]),
    ).toEqual([{ line: 2, name: 'Ana', email: 'a@x.com', cpf: '12345678909' }]);
  });
});

describe('estimateSendHours', () => {
  it('arredonda para cima', () => {
    expect(estimateSendHours(1180, 100)).toBe(12);
  });
});

describe('isInactiveSituacao', () => {
  it.each(['Inativo', 'DESLIGADO', 'Demitido', 'Rescisão', 'Falecido'])('%s é inativo', (value) => {
    expect(isInactiveSituacao(value)).toBe(true);
  });

  it.each([null, '', 'Ativo', 'Afastado', 'Férias'])('%s é ativo', (value) => {
    expect(isInactiveSituacao(value)).toBe(false);
  });
});
